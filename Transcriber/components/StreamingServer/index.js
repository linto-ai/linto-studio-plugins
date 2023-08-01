const debug = require('debug')(`transcriber:StreamingServer`);
const gstreamer = require('gstreamer-superficial');
const { Component, CustomErrors } = require("live-srt-lib");
const dgram = require('dgram');
const { exec } = require('child_process');

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
    socket.bind(port, () => {
      socket.once('close', () => {
        resolve(false);
      });
      socket.close();
    });
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
    this.init().then(async () => { const port = await findFreeUDPPortInRange(); this.port = port; this.start(); })
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
      this.streamingHost = process.env.STREAMING_HOST;
      this.srtMode = process.env.SRT_MODE
      switch (process.env.STREAMING_PROTOCOL) {
        case "SRT":
          this.streamURI = `srt://${this.streamingHost}:${this.port}?mode=${this.srtMode}`;
          if (this.passphrase) {
            this.streamURI += `&passphrase=${this.passphrase}`;
          }
          this.pipelineString = `srtsrc uri="${this.streamURI}" ${transcodePipelineString}`;
          // change streamURI to get client version of the stream endpoint, if caller is used in pipeline, sets mode to listener, if listener is used in pipeline, sets mode to caller, if mode is rendezvous, keeps mode as rendezvous
          if (this.srtMode === "caller") {
            this.streamURI = this.streamURI.replace("caller", "listener")
          } else if (this.srtMode === "listener") {
            this.streamURI = this.streamURI.replace("listener", "caller")
          }
          break;
        case "RTMP":
          this.appName = "live";
          this.streamName = "stream";
          this.streamURI = `rtmp://${this.streamingHost}:${this.port}/${this.appName}/${this.streamName}`;
          this.pipelineString = `flvmux name=mux ! rtmpsink location=${this.streamURI} ${transcodePipelineString}`;
          break;
        default:
          throw new CustomErrors.streamingServerError("STREAMING_PROTOCOL_MISSMATCH", "STREAMING_PROTOCOL must be either SRT or RTMP")
      }


      this.pipeline = new gstreamer.Pipeline(this.pipelineString);

      this.pipeline.pollBus((msg) => {
        switch (msg.type) {
          case 'eos':
            this.emit('eos');
            this.stop();
            this.start(); //reloads the pipeline
            break;
          case 'state-changed':
            if (msg._src_element_name === 'sink') {
              // Here we might do something when the appsink state changes
              // like console.log(`Sink state changed from ${msg['old-state']} to ${msg['new-state']}`);
            }
            break;
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