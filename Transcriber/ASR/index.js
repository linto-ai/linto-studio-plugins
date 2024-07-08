const debug = require('debug')(`transcriber:ASR`);
const eventEmitter = require('eventemitter3');
const path = require('path');
const fs = require('fs');
const { CircularBuffer } = require("live-srt-lib");
const ASR_ERROR = require('./error.js')


function loadAsr(provider) {
  const asrPath = path.join(__dirname, provider, 'index.js');
  if (!fs.existsSync(asrPath)) {
    throw new Error(`No ASR named '${provider}' in '${asrPath}'`);
  }
  const AsrClass = require(asrPath);
  return AsrClass;
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
      
      if (channel.keepAudio){
        this.audioFile = fs.createWriteStream(`${this.session.id}-${this.channelIndex}.pcm`);
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
      this.state = TRANSCRIBING;
      this.emit('partial', transcription);
    });
    this.provider.on('transcribed', (transcription) => {
      this.emit('final', transcription);
    });
  }

  async dispose(){
    try {
      if (this.audioFile) {
        this.audioFile.close();
      }
      if (this.provider) {
        this.provider.removeAllListeners();
        await this.provider.stop();
      }

    } catch (error) {
      this.emit('error', error);
      return false
    }
    this.audioBuffer = null;
    this.provider = null;
    this.removeAllListeners();
    return true
  }
  
  transcribe(buffer) {
    this.audioBuffer.add(buffer);
    if (!(this.state === ASR.states.READY || this.state === ASR.states.TRANSCRIBING)) return;
    const audioBuffer = this.audioBuffer.getAudioBuffer();
    if (audioBuffer.length >= Math.floor(process.env.MIN_AUDIO_BUFFER/1000 * process.env.SAMPLE_RATE * process.env.BYTES_PER_SAMPLE)) {
      if (this.keepAudio) {
        this.audioFile.write(audioBuffer);
      }
      this.provider.transcribe(audioBuffer);
      this.audioBuffer.flush();
    }
  }
}

module.exports = ASR;