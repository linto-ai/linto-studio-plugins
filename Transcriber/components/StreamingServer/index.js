const debug = require('debug')(`transcriber:StreamingServer`);
const gstreamer = require('gstreamer-superficial');
const { Component, CustomErrors } = require("live-srt-lib");
const dgram = require('dgram');
const { exec } = require('child_process');
const fs = require('fs')

async function findFreeUDPPortInRange() {
  const [startPort, endPort] = process.env.UDP_RANGE.split('-');
  for (let port = startPort; port <= endPort; port++) {
    if (!(await isUDPPortInUse(port))) {
      return port;
    }
  }
  throw new Error(`No available UDP port found in range ${startPort}-${endPort}`);
}

function isUDPPortInUse(port) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    setTimeout(() => {
      socket.bind(port, () => {
        socket.once('close', () => {
          resolve(false);
        });
        socket.close();
      });
    }, Math.floor(Math.random() * 4500) + 500); // Wait for a random time between 500 and 5000 milliseconds
    socket.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve(true);
      } else {
        reject(err);
      }
    });
  });
}

function generatePassphrase() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15)
}

class StreamingServer extends Component {
  static states = {
    READY: 'ready',
    ERROR: 'error',
    STREAMING: 'streaming',
    CLOSED: 'closed'
  };

  constructor(app) {
    super(app);
    this.id = this.constructor.name; //singleton ID within transcriber app
    this.state = StreamingServer.states.CLOSED;
    this.streamURI = null;
    this.error_repetition = 0
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
      this.port = await findFreeUDPPortInRange();
      this.start()
    })
  }

  async start() {

    const { READY, ERROR, STREAMING, CLOSED } = this.constructor.states;
    let transcodePipelineString = `! queue
    ! decodebin
    ! queue
    ! audioconvert
    ! audio/x-raw,format=S16LE,channels=1
    ! queue
    ! audioresample
    ! audio/x-raw,rate=16000
    ! queue
    ! appsink name=sink`
    try {
      this.srtMode = process.env.SRT_MODE
      switch (process.env.STREAMING_PROTOCOL) {
        case "SRT":
          const streamingProxyHost = process.env.STREAMING_PROXY_HOST === "false" ? this.streamingHost : process.env.STREAMING_PROXY_HOST || this.streamingHost;
          const streamingProxyPort = process.env.STREAMING_PROXY_PORT === "false" ? this.port : process.env.STREAMING_PROXY_PORT || this.port;
          this.streamURI = `srt://${streamingProxyHost}:${streamingProxyPort}?mode=${this.srtMode}`;
          this.internalStreamURI = `srt://${this.streamingHost}:${this.port}?mode=${this.srtMode}`;
          if (this.passphrase) {
            this.internalStreamURI += `&passphrase=${this.passphrase}`;
            this.streamURI += `&passphrase=${this.passphrase}`;
          }
          this.pipelineString = `srtsrc uri="${this.internalStreamURI}" ${transcodePipelineString}`;
          // change streamURI to get client version of the stream endpoint, if caller is used in pipeline, sets mode to listener, if listener is used in pipeline, sets mode to caller, if mode is rendezvous, keeps mode as rendezvous
          if (this.srtMode === "caller") {
            this.streamURI = this.streamURI.replace("caller", "listener")
          } else if (this.srtMode === "listener") {
            this.streamURI = this.streamURI.replace("listener", "caller")
          }
          break;
        case "RTMP":
          // TODO: add support for RTMP, WebRTC and maybe others 
          this.appName = "live";
          this.streamName = "stream";
          this.streamURI = `rtmp://${this.streamingHost}:${this.port}/${this.appName}/${this.streamName}`;
          this.pipelineString = `flvmux name=mux ! rtmpsink location=${this.streamURI} ${transcodePipelineString}`;
          break;
        default:
          throw new CustomErrors.streamingServerError("STREAMING_PROTOCOL_MISSMATCH", "STREAMING_PROTOCOL must be either SRT or RTMP")
      }


      this.pipeline = new gstreamer.Pipeline(this.pipelineString);

      this.pipeline.pollBus(async (msg) => {
        switch (msg.type) {
          case 'eos':
            this.emit('eos'); // ASR/Controller will handle this to flush buffer and stop transcription
            this.stop();
            this.start(); //reloads the pipeline
            break;
          case 'state-changed':
            if (msg._src_element_name === 'sink') {
              // Here we might do something when the appsink state changes
              //debug(`Sink state changed from ${msg['old-state']} to ${msg['new-state']}`);
            }
            break;
          case 'error':
            // When the application receives an error message it should stop playback of the pipeline
            // and not assume that more data will be played.
            // It can be caused by a port conflict so we try to reload the pipeline only 5 times to mitigate this port conflict occuring with other transcriber instances
            if (this.error_repetition > 5) {
              debug("Too many errors when trying to start GStreamer pipeline")
              process.exit(1) // exits the process with an error code. This will trigger a restart of the container by docker-compose or orchestrator
            }
            debug("Error when trying to create GStreamer streaming server, retrying...")
            this.error_repetition += 1
            this.stop()
            this.port = await findFreeUDPPortInRange();
            this.start()
          default:
            break;
        }
      });

      // Find the appsink element in the pipeline
      this.appsink = this.pipeline.findChild('sink');

      // Define a callback function to handle new audio samples
      const onData = (buf, caps) => {
        if ((this.state === READY && buf)) {
          this.state = STREAMING;
        }
        if (buf) {
          this.emit('audio', buf);
          // Continue pulling audio samples from the appsink element, if no buffer, the pipeline pollbus will emit an eos event
          this.appsink.pull(onData); // recurses
        }
      }

      this.pipeline.play();
      this.appsink.pull(onData);
      this.state = READY;
      debug(`Streaming Server is reachable on ${this.streamURI}`)
    } catch (error) {
      console.log(error)
      this.state = ERROR;
      //this.start();
    }

  }

  stop() {
    this.pipeline.stop();
    delete this.appsink;
    delete this.pipeline
    this.state = StreamingServer.states.CLOSED;
  }
}


module.exports = app => new StreamingServer(app);
