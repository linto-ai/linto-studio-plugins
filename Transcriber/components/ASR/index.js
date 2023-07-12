const debug = require('debug')(`transcriber:ASR`);
const { Component } = require("live-srt-lib");
const LintoTranscriber = require('./linto');
const MicrosoftTranscriber = require('./microsoft');


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
    this.setTranscriber(process.env.ASR_PROVIDER);
  }

  configure(channel, transcriberProfile) {
    this.setTranscriber(transcriberProfile.config.type, { channel, transcriberProfile })
    this.emit('reconfigure');
  }

  // TODO: There's a bug here... don't know what it is yet, but it's causing the transcriber to be set three times upon reconfigure
  setTranscriber(transcriber, options=null) {
    const { CONNECTING, READY, ERROR, CLOSED, TRANSCRIBING } = this.constructor.states;
    this.state = ASR.states.CLOSED;
    switch (transcriber) {
      case 'linto':
        this.transcriber = options ? new LintoTranscriber(options.channel, options.transcriberProfile) : new LintoTranscriber();
        break;
      case 'microsoft':
        this.transcriber = options ? new MicrosoftTranscriber(options.channel, options.transcriberProfile) : new MicrosoftTranscriber();
        break;
      default:
        // handle default case
        break;
    }
    this.state = ASR.states.CLOSED;
    this.transcriber.on('connecting', () => {
      debug('connecting');
      this.state = CONNECTING;
    });
    this.transcriber.on('ready', () => {
      debug('ready');
      this.state = READY;
    });
    this.transcriber.on('error', error => { this.state = ERROR });
    this.transcriber.on('close', (code, reason) => {
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
    this.init(); //attaches event controllers
  }


  async startTranscription() {
    this.transcriber.start();
  }

  async stopTranscription() {
    this.transcriber.stop();
  }

  transcribe(buffer) {
    this.transcriber.transcribe(buffer);
  }
}

module.exports = app => new ASR(app);