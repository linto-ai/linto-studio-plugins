const { fork } = require('child_process');
const { CustomErrors } = require("live-srt-lib");
const path = require('path');

function generatePassphrase() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15)
}

class SRTServer {
  constructor(streamingServer) {
    this.streamingServer = streamingServer;
    this.worker = null;
    this.streamingServer.servers.push(this);
    this.listener = this.listener.bind(this);
    this.srtMode = process.env.SRT_MODE || "listener";
    this.serverType = 'srt'
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
    switch (msg.type) {
      case 'reinit':
        this.worker.send({type: 'initialize'});
        break;
    }
  }

  getStreamUri(streamingProxyHost, streamingProxyPort) {
    let streamURI = `srt://${streamingProxyHost}:${streamingProxyPort}?mode=${this.srtMode}`;
    if (this.passphrase) {
      streamURI += `&passphrase=${this.passphrase}`;
    }
    if (this.srtMode === "caller") {
      streamURI = streamURI.replace("caller", "listener")
    } else if (this.srtMode === "listener") {
      streamURI = streamURI.replace("listener", "caller")
    }
    return streamURI;
  }

  stopWorker() {
    if(this.worker) {
      this.worker.send({type: 'stop_pipeline'});
      this.worker.kill();
      this.worker = null;
    }
  }

  startWorker() {
    this.worker = fork(path.join(__dirname, 'srt-worker.js'), [], {
      env: {
        ...process.env,
        mode: this.srtMode || '',
        streamingHost: this.streamingServer.streamingHost || '',
        passphrase: this.passphrase || '',
        srtPort: this.streamingServer.ports_selected[this.serverType] || ''
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


module.exports = SRTServer;
