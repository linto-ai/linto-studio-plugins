const debug = require('debug')(`transcriber:StreamingServer`);
const { Component, CustomErrors } = require("live-srt-lib");
const MultiplexedSRTServer = require('./srt/SRTServer.js');

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
    this.init().then(async () => {
      // intialize the streaming servers
      this.initialize();
    })
  }

  async initialize() {
    this.srtServer = new MultiplexedSRTServer(this.app)

    this.srtServer.on('session-start', (session, channel) => {
      debug(`Session ${session.id}, channel ${channel} started`);
      this.emit('session-start', session, channel);
    })

    this.srtServer.on('session-stop', (session, channel) => {
      debug(`Session ${session.id}, channel ${channel} stopped`);
      // pass to controllers/StreamingServer.js
      this.emit('session-stop', session, channel);
    })

    this.srtServer.on('data', (data) => {
      // TOOD: handle data
    });
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
