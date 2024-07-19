const debug = require('debug')(`transcriber:ASR`);
const eventEmitter = require('eventemitter3');
const path = require('path');
const fs = require('fs');
const { CircularBuffer } = require("live-srt-lib");
const ffmpeg = require('fluent-ffmpeg');
const ASR_ERROR = require('./error.js')


function loadAsr(provider) {
  const asrPath = path.join(__dirname, provider, 'index.js');
  if (!fs.existsSync(asrPath)) {
    throw new Error(`No ASR named '${provider}' in '${asrPath}'`);
  }
  const AsrClass = require(asrPath);
  return AsrClass;
}

//@TODO: add ffmpeg in docker builds
function transcodeToMp3(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .inputFormat('s16le')      // Specify the input format as signed 16-bit little-endian PCM
      .inputOptions(['-ar 16000', '-ac 1'])
      .audioCodec('libmp3lame')
      .audioBitrate('64k')
      .on('end', () => {
        debug(`Transcoding to MP3 completed: ${outputPath}`);
        resolve();
      })
      .on('error', (err) => {
        console.error(`Error during transcoding: ${err.message}`);
        reject(err);
      })
      .save(outputPath);
  });
}

class ASR extends eventEmitter {
  static states = {
    CONNECTING: 'connecting',
    READY: 'ready',
    ERROR: 'error',
    CLOSED: 'closed',
    TRANSCRIBING: 'transcribing'
  };

  constructor(session, channelIndex) {
    super();
    this.session = session;
    this.channelIndex = channelIndex;
    this.provider = null;
    this.keepAudio = false;
    this.state = ASR.states.CLOSED;
    this.init();
  }

  async init() {
    // identifies the transcriber profile for the channel channelIndex in the session channels array
    try {
      const channel = this.session.channels.find(c => c.index === this.channelIndex);

      if (channel.keepAudio) {
        const audioFilePath = path.join(process.env.AUDIO_STORAGE_PATH, `${this.session.id}-${this.channelIndex}.pcm`);
        this.audioFile = fs.createWriteStream(audioFilePath);
        this.keepAudio = true;
      }
      this.audioBuffer = new CircularBuffer();
      debug(`Starting ${channel.transcriber_profile.config.type} ASR for session ${this.session.id}, channel ${this.channelIndex}`);
      const backend = loadAsr(channel.transcriber_profile.config.type);
      this.provider = new backend(channel);
      this.state = ASR.states.CONNECTING;
      await this.provider.start();
      this.state = ASR.states.READY
      this.handleASREvents();
    } catch (error) {
      console.error(error);
      this.state = ASR.states.ERROR;
      this.emit('error', error);
    }
  }

  handleASREvents() {
    this.provider.on('connecting', () => {
      this.state = ASR.states.CONNECTING;
    });
    this.provider.on('ready', () => {
      this.state = ASR.states.READY;
    });
    this.provider.on('error', error => {
      const msg = ASR_ERROR[error]
      const final = {
        "astart": this.startedAt,
        "text": msg,
        "start": Math.floor(new Date().getTime() / 1000) - this.startTimestamp,
        "end": Math.floor(new Date().getTime() / 1000) - this.startTimestamp,
        "lang": 'EN-en',
        "locutor": process.env.TRANSCRIBER_BOT_NAME
      }
      this.emit('final', final)
      console.error(msg)
      this.state = ASR.states.ERROR
    })
    this.provider.on('closed', (code, reason) => {
      debug(`ASR connexion closed with code ${code}`);
      this.state = ASR.states.CLOSED;
    });
    this.provider.on('transcribing', (transcription) => {
      this.state = ASR.states.TRANSCRIBING;
      this.emit('partial', transcription);
    });
    this.provider.on('transcribed', (transcription) => {
      this.emit('final', transcription);
    });
  }

  async dispose() {
    try {
      if (this.audioFile) {
        this.audioFile.close();
        const pcmFilePath = path.join(process.env.AUDIO_STORAGE_PATH, `${this.session.id}-${this.channelIndex}.pcm`);
        let mp3FilePath = path.join(process.env.AUDIO_STORAGE_PATH, `${this.session.id}-${this.channelIndex}.mp3`); // Use let for reassignment
        // if mp3 file already exists, add an index to the filename to be saved
        if (fs.existsSync(mp3FilePath)) {
          let index = 1;
          while (fs.existsSync(mp3FilePath)) {
            mp3FilePath = path.join(process.env.AUDIO_STORAGE_PATH, `${this.session.id}-${this.channelIndex}_${index}.mp3`);
            index++;
          }
        }
        await transcodeToMp3(pcmFilePath, mp3FilePath);
        debug(`Audio file saved as ${mp3FilePath}`);
        fs.unlinkSync(pcmFilePath);
      }
      if (this.provider) {
        this.provider.removeAllListeners();
        await this.provider.stop();
      }
    } catch (error) {
      this.emit('error', error);
      return false;
    }
    this.audioBuffer = null;
    this.provider = null;
    this.removeAllListeners();
    return true;
  }

  transcribe(buffer) {
    this.audioBuffer.add(buffer);
    if (!(this.state === ASR.states.READY || this.state === ASR.states.TRANSCRIBING)) return;
    const audioBuffer = this.audioBuffer.getAudioBuffer();
    if (audioBuffer.length >= Math.floor(process.env.MIN_AUDIO_BUFFER / 1000 * process.env.SAMPLE_RATE * process.env.BYTES_PER_SAMPLE)) {
      if (this.keepAudio) {
        this.audioFile.write(audioBuffer);
      }
      this.provider.transcribe(audioBuffer);
      this.audioBuffer.flush();
    }
  }
}

module.exports = ASR;