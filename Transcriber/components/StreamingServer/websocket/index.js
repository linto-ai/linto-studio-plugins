const { fork } = require('child_process');
const { CustomErrors } = require("live-srt-lib");
const path = require('path');

class WebsocketServer {
  constructor(streamingServer) {
    this.streamingServer = streamingServer;
    this.worker = null;
    this.streamingServer.servers.push(this);
    this.listener = this.listener.bind(this);
    this.serverType = 'websocket'
  }

  initialize() {
    this.restartWorker();
    this.worker.send({ type: 'initialize'});
  }

  start() {
    this.restartWorker();
    this.worker.send({ type: 'start'});
  }

  stop() {
    if (this.worker) {
      this.worker.send({ type: 'stop'});
    }
  }

  listener(msg) {
    this.streamingServer.listener(msg, this);
  }

  getStreamUri(streamingProxyHost, streamingProxyPort) {
    return `ws://${streamingProxyHost}:${streamingProxyPort}/stream`;
  }

  stopWorker() {
    if(this.worker) {
      this.worker.kill();
      this.worker = null;
    }
  }

  startWorker() {
    this.worker = fork(path.join(__dirname, 'websocket-worker.js'), [], {
      env: {
        ...process.env,
        streamingHost: this.streamingServer.streamingHost || '',
        websocketPort: this.streamingServer.ports_selected[this.serverType] || ''
      }
    });

    this.worker.on('message', (msg) => {
      this.listener(msg);
    });

    this.worker.on('error', (error) => {
      console.error(`[WORKER] error: ${error}`);
    });

    this.worker.on('exit', (code) => {
      console.error(`[WORKER] exit: ${code}`);
    });
  }

  restartWorker() {
    this.stopWorker();
    this.startWorker();
  }
}


module.exports = WebsocketServer;
