const debug = require('debug')(`transcriber:ASR`);
const { Component } = require("live-srt-lib");
const LintoTranscriber = require('./linto');
const MicrosoftTranscriber = require('./microsoft');
const ASR_ERROR = require('./error.js')


class ASR extends Component {
  static states = {
    CONNECTING: 'connecting',
    READY: 'ready',
    ERROR: 'error',
    CLOSED: 'closed',
    TRANSCRIBING: 'transcribing'
  };

  constructor(app) {
    super(app);
    this.id = this.constructor.name;
    this.startedAt = null
    this.startTimestamp = null
    this.setTranscriber(process.env.ASR_PROVIDER);
    this.init(); //attaches event controllers
  }

  configure(transcriberProfile) {
    this.setTranscriber(transcriberProfile.config.type, transcriberProfile);
    this.emit('reconfigure'); // Handled by Brokerclient ASRevents controller to forward reconfigured transcriber info to the scheduler through mqtt
  }

  setTranscriber(transcriber, transcriberProfile=null) {
    const { CONNECTING, READY, ERROR, CLOSED, TRANSCRIBING } = this.constructor.states;
    // Free previous listeners
    if (this.transcriber) {
      this.transcriber.removeAllListeners();
    }
    switch (transcriber) {
      case 'linto':
        this.transcriber = transcriberProfile ? new LintoTranscriber(transcriberProfile) : new LintoTranscriber();
        break;
      case 'microsoft':
        this.transcriber = transcriberProfile ? new MicrosoftTranscriber(transcriberProfile) : new MicrosoftTranscriber();
        break;
      default:
        // handle default case
        break;
    }
    this.state = ASR.states.CLOSED;
    // Set new listeners
    this.transcriber.on('connecting', () => {
      debug('connecting');
      this.state = CONNECTING;
    });
    this.transcriber.on('ready', () => {
      debug('ready');
      this.state = READY;
    });
    this.transcriber.on('error', error => {
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
      this.state = ERROR
    })
    this.transcriber.on('closed', (code, reason) => {
      debug(`ASR connexion closed with code ${code}`);
      this.state = CLOSED;
    });
    this.transcriber.on('transcribing', (transcription) => {
      this.state = TRANSCRIBING;
      this.emit('partial', transcription);
    });
    this.transcriber.on('transcribed', (transcription) => {
      this.emit('final', transcription);
    });
  }


  async startTranscription() {
    this.transcriber.start();
    this.startedAt = new Date().toISOString();
    this.startTimestamp = Math.floor(new Date().getTime() / 1000)
  }

  async stopTranscription() {
    this.transcriber.stop();
  }

  transcribe(buffer) {
    this.transcriber.transcribe(buffer);
  }
}

module.exports = app => new ASR(app);
