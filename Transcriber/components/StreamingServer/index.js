const debug = require('debug')(`transcriber:StreamingServer`);
const { Component, CustomErrors } = require("live-srt-lib");
const ASR = require('../../ASR');
const MultiplexedSRTServer = require('./srt/SRTServer.js');
const JitsiBot = require('./jitsi');

class StreamingServer extends Component {
  static states = {
    INITIALIZED: 'initialized',
    READY: 'ready',
    ERROR: 'errored',
    STREAMING: 'streaming',
    CLOSED: 'closed'
  };

  constructor(app) {
    super(app);
    this.id = this.constructor.name; //singleton ID within transcriber app
    this.state = StreamingServer.states.CLOSED;
    this.ASRs = new Map();
    this.init().then(async () => {
      // intialize the streaming servers
      this.initialize();
    })
  }

  async initialize() {
    this.srtServer = new MultiplexedSRTServer(this.app)
    this.srtServer.on('session-start', (session, channelIndex) => {
      // Start some ASR. session object holds everything required to start ASR (profile, keys...)
      const asr = new ASR(session, channelIndex);
      // Store the ASR instance in the map like :
      // session.id_channelIndex -> ASR instance
      this.ASRs.set(`${session.id}_${channelIndex}`, asr);
      // pass to controllers/StreamingServer.js to forward to broker
      this.emit('session-start', session, channelIndex);
      debug(`Session ${session.id}, channel ${channelIndex} started`);
    })

    this.srtServer.on('session-stop', (session, channelIndex) => {
      debug(`Session ${session.id}, channel ${channelIndex} stopped`);
      // Retrieve the ASR instance from the map
      const asr = this.ASRs.get(`${session.id}_${channelIndex}`);
      // Stop the ASR instance
      asr.dispose()
      // Remove the ASR instance from the map
      this.ASRs.delete(`${session.id}_${channelIndex}`);
      // pass to controllers/StreamingServer.js to forward to broker
      this.emit('session-stop', session, channelIndex);
    })

    this.srtServer.on('data', (audio, sessionId, channelIndex) => {
      const buffer = Buffer.from(audio.data);
      const asr = this.ASRs.get(`${sessionId}_${channelIndex}`);
      if (asr) {
        asr.transcribe(buffer);
      } else {
        //debug(`No ASR found for session ${message.sessionId}, channel ${message.channelIndex}`);
      }
    });
  }
  

  // Create a bot and connect to Jitsi
  async startJitsi(session, channelIndex, address) {
    debug(`Starting Jitsi bot for session ${session.id}, channel ${channelIndex}`);
    this.bot = new JitsiBot(session, channelIndex, address);
    this.bot.init();
    
    this.bot.on('session-start', (session, channelIndex) => {
      const asr = new ASR(session, channelIndex);
      this.ASRs.set(`${session.id}_${channelIndex}`, asr);
      // pass to controllers/StreamingServer.js to forward to broker
      this.emit('session-start', session, channelIndex);
      debug(`Session ${session.id}, channel ${channelIndex} started`);
    })

    this.bot.on('data', (audio, sessionId, channelIndex) => {
      const buffer = Buffer.from(audio.data);
      const asr = this.ASRs.get(`${sessionId}_${channelIndex}`);
      if (asr) {
        asr.transcribe(buffer);
      } else {
        //debug(`No ASR found for session ${message.sessionId}, channel ${message.channelIndex}`);
      }
    })
  }

  async startServers() {
    if (!this.srtServer) {
      return
    }
    this.srtServer.start();
  }

  async stopServers() {
    if (!this.srtServer) {
      return
    }
    this.srtServer.stop();
  }

  // called by controllers/BrokerClient.js uppon receiving system/out/sessions/statuses message
  setSessions(sessions) {
    this.srtServer.setSessions(sessions);
  }

}


module.exports = app => new StreamingServer(app);
