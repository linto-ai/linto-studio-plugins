const debug = require('debug')(`transcriber:StreamingServer`);
const { Component, CustomErrors } = require("live-srt-lib");
const SRTServer = require('./srt/index.js');
const RTMPServer = require('./rtmp/index.js');
const WebsocketServer = require('./websocket/index.js');

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
    this.protocols = process.env.STREAMING_PROTOCOL.split(',').map(protocol => protocol.trim());
    this.streamURIs = {}; // srt:..., rtmp:..., websocket:...
    this.streamURI = ""; // as a comma separated list of URIs
    this.servers = []; // array of server workers
    this.ports_selected = {}; //srt:..., rtmp:..., websocket:...
    this.listener = this.listener.bind(this);
    this.streamingHost = process.env.STREAMING_HOST || "0.0.0.0";
    this.init().then(async () => {
      // intialize the streaming servers
      this.initialize();
    })
  }

  async initialize() {
    try {
      this.stop();
      this.servers = [];
      for (const protocol of this.protocols) {
        switch (protocol) {
          case "SRT":
            new SRTServer(this).initialize();
            break;
          case "RTMP":
            new RTMPServer(this).initialize();
            break;
          case "WEBSOCKET":
            new WebsocketServer(this).initialize();
            break;
          default:
            throw new CustomErrors.streamingServerError("STREAMING_PROTOCOL_MISSMATCH", `STREAMING_PROTOCOL must be either SRT or RTMP or WEBSOCKET, but got ${protocol}`)
        }
      }
    } catch (error) {
      debug(error)
      process.exit(1)
      // When the application receives an error message it should stop playback of the pipeline
      // and not assume that more data will be played.
      // It can be caused by a port conflict so we try to reload the pipeline only 5 times to mitigate this port conflict occuring with other transcriber instances
      // exits the process with an error code. This will trigger a restart of the container by docker-compose or orchestrator
    }
  }

  listener(msg, server) {
    switch (msg.type) {
      case 'error':
        throw new CustomErrors.streamingServerError("STREAMING_SERVER_ERROR", msg.data);
      case 'reinit':
        debug(`Reinitializing ${server.serverType} server: ${msg.data}`)
        this.state = StreamingServer.states.CLOSED;
        server.initialize();
        break;
      case 'port_selected':
        debug(`${server.serverType} server initialized on port ${msg.data}`)
        const port = msg.data;
        this.ports_selected[server.serverType] = port;
        const streamingProxyHost = process.env.STREAMING_PROXY_HOST === "false" ? this.streamingHost : process.env.STREAMING_PROXY_HOST || this.streamingHost;
        const streamingProxyPort = process.env.STREAMING_PROXY_PORT === "false" ? port : process.env.STREAMING_PROXY_PORT || port;
        this.streamURIs[server.serverType] = server.getStreamUri(streamingProxyHost, streamingProxyPort);
        this.rebuildState();
        this.state = StreamingServer.states.INITIALIZED;
        break;
      case 'info':
        debug(msg.data);
        break;
      case 'ready':
        debug("server ready to stream")
        this.state = StreamingServer.states.READY;
        break;
      case 'closed':
        debug("server closed")
        this.state = StreamingServer.states.CLOSED;
        server.initialize();
        break;
      case 'eos':
        debug("server End Of Stream")
        this.emit('eos');
        this.start();
        break;
      case 'audio':
        if (this.state == StreamingServer.states.READY) {
          debug("server streaming");
          this.state = StreamingServer.states.STREAMING;
        }
        this.emit('audio', Buffer.from(msg.data));
        break;
    }
  }

  //Switch transcriber to initialized state, rebuilds streamURI endpoint. Switching states triggers a emit event
  rebuildState() {
    this.streamURI = Object.values(this.streamURIs).join(',');
  }

  start() {
    this.servers.forEach(server => {
      server.start();
    })
  }

  stop() {
    this.servers.forEach(server => {
      server.stop();
    })
  }
}


module.exports = app => new StreamingServer(app);
