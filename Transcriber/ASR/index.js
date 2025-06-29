const eventEmitter = require('eventemitter3');
const path = require('path');
const fs = require('fs');
const { CircularBuffer, logger } = require("live-srt-lib");
const ffmpeg = require('fluent-ffmpeg');
const ASR_ERROR = require('./error.js');
const FakeTranscriber = require('./fake/index.js');


function loadAsr(provider) {
  const asrPath = path.join(__dirname, provider, 'index.js');
  if (!fs.existsSync(asrPath)) {
    throw new Error(`No ASR named '${provider}' in '${asrPath}'`);
  }
  const AsrClass = require(asrPath);
  return AsrClass;
}

async function transcodeToMp3(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .inputFormat('s16le')      // Specify the input format as signed 16-bit little-endian PCM
      .inputOptions(['-ar 16000', '-ac 1'])
      .audioCodec('libmp3lame')
      .audioBitrate('64k')
      .on('end', () => {
        logger.debug(`Transcoding to MP3 completed: ${outputPath}`);
        resolve();
      })
      .on('error', (err) => {
        logger.error(`Error during transcoding: ${err.message}`);
        reject(err);
      })
      .save(outputPath);
  });
}

async function transcodeToWav(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .inputFormat('s16le')      // Specify the input format as signed 16-bit little-endian PCM
      .inputOptions(["-ar 16000", "-ac 1"])
      .audioCodec("pcm_s16le")
      .output(outputPath)
      .on("end", resolve)
      .on("error", (err) => {
        logger.error(`Error transcoding to WAV: ${err.message}`);
        reject(err);
      })
      .run();
  });
}

async function concatAudioFiles(input1, input2, output) {
  return new Promise((resolve, reject) => {
    ffmpeg(input1)
      .input(input2)
      .on('end', () => {
        logger.debug(`Concat completed: ${output}`);
        resolve()
      })
      .on('error', (err) => {
        logger.error(`Error during concat: ${err.message}`)
        reject(err)
      })
      .mergeToFile(output, '/tmp');
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

  constructor(session, channel) {
    super();
    this.session = session;
    this.channel = channel;
    this.provider = null;
    this.state = ASR.states.CLOSED;
    this.init();
  }

  async init() {
    // identifies the transcriber profile for the channel channel.id in the session channels array
    try {
      const channel = this.channel

      if (channel.keepAudio) {
        const audioFilePath = path.join(process.env.AUDIO_STORAGE_PATH, `${this.session.id}-${this.channel.id}.pcm`);
        this.audioFile = fs.createWriteStream(audioFilePath);
      }
      this.audioBuffer = new CircularBuffer();
      logger.debug(`Starting ${channel.transcriberProfile.config.type} ASR for session ${this.session.id}, channel ${this.channel.id}`);

      // Use the FakeTranscriber if live transcripts are disabled
      if (!this.channel.enableLiveTranscripts) {
        this.provider = new FakeTranscriber(channel);
        logger.info("ASR started with FakeTranscriber");
      }
      else {
        const backend = loadAsr(channel.transcriberProfile.config.type);
        this.provider = new backend(channel);
      }
      this.state = ASR.states.CONNECTING;
      this.handleASREvents();
      await this.provider.start();
    } catch (error) {
      logger.error(error);
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
        "astart": this.provider.startedAt,
        "text": msg,
        "start": Math.floor(new Date().getTime() / 1000) - this.startTimestamp,
        "end": Math.floor(new Date().getTime() / 1000) - this.startTimestamp,
        "lang": 'EN-en',
        "locutor": process.env.TRANSCRIBER_BOT_NAME
      }
      this.emit('final', final)
      logger.error(msg)
      this.state = ASR.states.ERROR
    })
    this.provider.on('closed', (code, reason) => {
      logger.debug(`ASR connexion closed with code ${code}`);
      this.state = ASR.states.CLOSED;
    });
    this.provider.on('transcribing', (transcription) => {
      this.state = ASR.states.TRANSCRIBING;
      if (transcription.text.trim().length > 0) {
        this.emit('partial', transcription);
      }
    });
    this.provider.on('transcribed', (transcription) => {
      if (transcription.text.trim().length > 0) {
        this.emit('final', transcription);
      }
    });
  }

  streamStopped() {
      const final = {
        "astart": this.provider.startedAt,
        "aend": new Date().toISOString(),
        "locutor": process.env.TRANSCRIBER_BOT_NAME
      }
      this.emit('final', final)
  }

  async saveAudio() {
    const fileExtension = this.channel.compressAudio ? '.mp3' : '.wav';
    const transcodeFn = this.channel.compressAudio ? transcodeToMp3 : transcodeToWav;
    const pcmFilePath = path.join(process.env.AUDIO_STORAGE_PATH, `${this.session.id}-${this.channel.id}.pcm`);
    let outFilePath = path.join(process.env.AUDIO_STORAGE_PATH, `${this.session.id}-${this.channel.id}`) + fileExtension;

    if (fs.existsSync(outFilePath)) {
      const tempOutFilePath = path.join(process.env.AUDIO_STORAGE_PATH, `${this.session.id}-${this.channel.id}-temp`) + fileExtension;
      const tempOutputFilePath = path.join(process.env.AUDIO_STORAGE_PATH, `${this.session.id}-${this.channel.id}-output`) + fileExtension;
      await transcodeFn(pcmFilePath, tempOutFilePath);
      await concatAudioFiles(outFilePath, tempOutFilePath, tempOutputFilePath);
      fs.unlinkSync(tempOutFilePath);
      fs.renameSync(tempOutputFilePath, outFilePath);
    } else {
      await transcodeFn(pcmFilePath, outFilePath);
    }

    logger.debug(`Audio file saved as ${outFilePath}`);
    fs.unlinkSync(pcmFilePath);
  }

  async dispose() {
    try {
      if (this.audioFile) {
        this.audioFile.close();
        await this.saveAudio();
      }
      if (this.provider) {
        this.provider.removeAllListeners();
        await this.provider.stop();
      }
    } catch (error) {
      logger.debug(`Error when saving the audio file: ${error}`)
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
      if (this.channel.keepAudio) {
        this.audioFile.write(audioBuffer);
      }
      this.provider.transcribe(audioBuffer);
      this.audioBuffer.flush();
    }
  }
}

module.exports = ASR;
