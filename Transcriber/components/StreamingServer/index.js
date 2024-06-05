const debug = require('debug')(`transcriber:StreamingServer`);
const { Component, CustomErrors } = require("live-srt-lib");
const { Worker, SHARE_ENV } = require('worker_threads');
const path = require('path');

function generatePassphrase() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15)
}

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
    this.srtMode = process.env.SRT_MODE || "listener";
    this.streamURIs = {}; // srt:..., rtmp:...
    this.streamURI = ""; // as a comma separated list of URIs
    this.servers = []; // array of server workers
    if (process.env.STREAMING_PASSPHRASE === "true") {
      this.passphrase = generatePassphrase();
    } else if (process.env.STREAMING_PASSPHRASE === "false") {
      this.passphrase = null;
    } else {
      if (process.env.STREAMING_PASSPHRASE.length < 10) {
        throw new CustomErrors.streamingServerError("STREAMING_PASSPHRASE", "Passphrase must be at least 10 characters long")
      }
      this.passphrase = process.env.STREAMING_PASSPHRASE;
    }
    this.streamingHost = process.env.STREAMING_HOST || "0.0.0.0";
    this.init().then(async () => {
      // intialize the streaming servers
      this.initialize();
    })
  }

  async initialize() {
    try {
      for (const server of this.servers) {
        // terminate all servers workers
        //remove message listeners
        server.removeAllListeners();
        server.terminate();
      }
      this.servers = [];
      for (const protocol of this.protocols) {
        switch (protocol) {
          case "SRT":
            this.initSRTServer();
            break;
          case "RTMP":
            this.initRTMPServer();
            break;
          default:
            throw new CustomErrors.streamingServerError("STREAMING_PROTOCOL_MISSMATCH", `STREAMING_PROTOCOL must be either SRT or RTMP, but got ${protocol}`)
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

  initSRTServer() {
    // spawn a worker to handle the server
    const worker = new Worker(path.join(__dirname, 'srt-worker.js'), {
      workerData: {
        mode: this.srtMode,
        streamingHost: this.streamingHost,
        passphrase: this.passphrase
      },
      env: SHARE_ENV
    });
    worker.postMessage('initialize');
    // add server to the internal list of servers
    this.servers.push(worker);
    worker.on('message', (msg) => {
      switch (msg.type) {
        case 'error':
          worker.terminate();
          worker.removeAllListeners();
          throw new CustomErrors.streamingServerError("STREAMING_SERVER_ERROR", msg.data);
        case 'reinit':
          debug("Reinitializing SRT server")
          this.state = StreamingServer.states.CLOSED;
          worker.postMessage('initialize');
          break;
        case 'port_selected':
          debug(`SRT server initialized on port ${msg.data}`)
          const srtPort = msg.data;
          const streamingProxyHost = process.env.STREAMING_PROXY_HOST === "false" ? this.streamingHost : process.env.STREAMING_PROXY_HOST || this.streamingHost;
          const streamingProxyPort = process.env.STREAMING_PROXY_PORT === "false" ? srtPort : process.env.STREAMING_PROXY_PORT || srtPort;
          this.streamURIs.srt = `srt://${streamingProxyHost}:${streamingProxyPort}?mode=${this.srtMode}`;
          if (this.passphrase) {
            this.streamURIs.srt += `&passphrase=${this.passphrase}`;
          }
          if (this.srtMode === "caller") {
            this.streamURIs.srt = this.streamURIs.srt.replace("caller", "listener")
          } else if (this.srtMode === "listener") {
            this.streamURIs.srt = this.streamURIs.srt.replace("listener", "caller")
          }
          this.rebuildState();
          this.state = StreamingServer.states.INITIALIZED;
          break;
        case 'info':
          debug(msg.data);
          break;
        case 'ready':
          debug("srt server ready to stream")
          this.state = StreamingServer.states.READY;
          break;
        case 'streaming':
          debug("srt server streaming")
          this.state = StreamingServer.states.STREAMING;
          break;
        default:
          break;
        case 'closed':
          debug("srt server closed")
          this.state = StreamingServer.states.CLOSED;
          break;
        case 'eos':
          debug("srt server End Of Stream")
          this.emit('eos');
          break;
        case 'audio':
          this.emit('audio', Buffer.from(msg.data));
          break;
      }
    });
  }

  initRTMPServer() {
    // spawn a worker to handle the server
    const worker = new Worker(path.join(__dirname, 'rtmp-worker.js'), {
      workerData: {
        streamingHost: this.streamingHost,
      },
      env: SHARE_ENV
    });
    worker.postMessage('initialize');
    // add server to the internal list of servers
    this.servers.push(worker);
    worker.on('message', (msg) => {
      switch (msg.type) {
        case 'error':
          worker.terminate();
          worker.removeAllListeners();
          throw new CustomErrors.streamingServerError("STREAMING_SERVER_ERROR", msg.data);
        case 'port_selected':
          debug(`RTMP server initialized on port ${msg.data}`)
          const rtmpPort = msg.data;
          const streamingProxyHost = process.env.STREAMING_PROXY_HOST === "false" ? this.streamingHost : process.env.STREAMING_PROXY_HOST || this.streamingHost;
          const streamingProxyPort = process.env.STREAMING_PROXY_PORT === "false" ? rtmpPort : process.env.STREAMING_PROXY_PORT || rtmpPort;
          this.streamURIs.rtmp = `rtmp://${streamingProxyHost}:${streamingProxyPort}/live/stream`;
          this.rebuildState();
          this.state = StreamingServer.states.INITIALIZED;
          break;
        case 'info':
          debug(msg.data);
          break;
        case 'ready':
          debug("rtmp server ready to stream")
          this.state = StreamingServer.states.READY;
          break;
        case 'streaming':
          debug("rtmp server streaming")
          this.state = StreamingServer.states.STREAMING;
          break;
        default:
          break;
        case 'closed':
          debug("rtmp server closed")
          this.state = StreamingServer.states.CLOSED;
          break;
        case 'eos':
          debug("rtmp server End Of Stream")
          this.emit('eos');
          break;
        case 'audio':
          this.emit('audio', Buffer.from(msg.data));
          break;
      }
    });
  }


  //Switch transcriber to initialized state, rebuilds streamURI endpoint. Switching states triggers a emit event
  rebuildState() {
    this.streamURI = Object.values(this.streamURIs).join(',');
  }

  start() {
    this.servers.forEach(server => {
      server.postMessage('start');
    })
  }

  stop() {
    this.servers.forEach(server => {
      server.postMessage('stop');
    })
  }
}


module.exports = app => new StreamingServer(app);
