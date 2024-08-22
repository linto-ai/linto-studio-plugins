const debug = require('debug')('transcriber:StreamingServer:RTMPServer');
const { fork } = require('child_process');
const EventEmitter = require('eventemitter3');
const NodeMediaServer = require('node-media-server');
const { CustomErrors } = require("live-srt-lib");
const path = require('path');

const {
    STREAMING_HOST,
    STREAMING_RTMP_TCP_PORT
} = process.env;

class MultiplexedRTMPServer extends EventEmitter {
  constructor(app) {
    super();
    this.app = app;
    this.nms = null;
    this.workers = {};
  }

  setSessions(sessions) {
      this.sessions = sessions;
  }

  async stop() {
      debug('RTMP server will go DOWN !');
      Object.keys(this.workers).forEach(sessionId => {
          this.cleanupConnection(sessionId);
        })
      this.workers = {};
      process.exit(1);
  }


  async start() {
      try {
          const config = {
            rtmp: {
              port: parseInt(STREAMING_RTMP_TCP_PORT),
              chunk_size: 60000,
              gop_cache: true,
              ping: 30,
              ping_timeout: 60
            }
          }
          this.nms = new NodeMediaServer(config);
          this.nms.run();
          this.nms.on("postPublish", (id, streamPath, args) => {
              this.onConnection(id, streamPath);
          });
          this.nms.on('donePublish', (id, streamPath, args) => {
            const [fd, worker] = this.workers.hasOwnProperty(id) ? this.workers[id] : [null, null];
            if (worker) {
                worker.send({ type: 'terminate' });
            }
            this.cleanupConnection(id);

          });
          debug(`RTMP server started on ${STREAMING_HOST}:${STREAMING_RTMP_TCP_PORT}`);
      } catch (error) {
          debug("Error starting RTMP server", error);
      }
  }

  async validateStream(streamPath) {
    const [sessionId, channelIndexStr] = streamPath.split('/').filter(element => element !== "")
    debug(`Connection: ${streamPath} --> Validating streamId ${streamPath}`);

      // Extract sessionId and channelIndex from streamId
      const channelIndex = parseInt(channelIndexStr, 10);
      const session = this.sessions.find(s => s.id === sessionId);
      // Validate session
      if (!session) {
          debug(`Connection: ${streamPath} --> session ${sessionId} not found.`);
          return { isValid: false };
      }
      // Find channel by "index" key (do not rely on position in array that changes upon updates)
      const channel = session.channels.find(c => c.index === channelIndex);
      if (!channel) {
          debug(`Connection: ${streamPath} --> session ${sessionId}, Channel index ${channelIndex} not found.`);
          return { isValid: false };
      }
      // Check if the channel's streamStatus is 'active'
      if (channel.streamStatus === 'active') {
          debug(`Connection: ${streamPath} --> session ${sessionId}, Channel index ${channelIndex} already active. Skipping.`);
          return { isValid: false };
      }
      debug(`Connection: ${streamPath} --> session ${sessionId}, channel ${channelIndex} is valid. Booting worker.`);
      return { isValid: true, sessionId, channelIndex, session };
  }

  async onConnection(sessionId, streamPath) {
      debug("Got new connection:", streamPath);
      // New connection, validate stream
      const validation = await this.validateStream(streamPath);
      if (!validation.isValid) {
          debug(`Invalid stream: ${streamPath}, voiding connection.`);
          this.cleanupConnection(sessionId, null, null);
          return;
      }

      // Stream is valid, store connection file descriptor
      const { channelIndex, session } = validation;
      // Create a new file descriptor object to store connection details and session info
      const fd = {
          channelIndex,
          session
      };
      // Start a new worker for this connection
      const worker = fork(path.join(__dirname, './RTMPGstreamerWorker.js'), [], {
      });
      this.workers[sessionId] = [fd, worker];
      // Start gstreamer pipeline
      worker.send({ type: 'init', streamPath: streamPath });
      // handle events
      this.handleWorkerEvents(sessionId, fd, worker);
      // Acknowledge session for streaming server controller to handle further processing
      // - call scheduler to update session status to active
      // - start buffering audio in circular buffer
      // - start transcription
      this.emit('session-start', fd.session, fd.channelIndex);
  }

  // Events sent by the worker
  handleWorkerEvents(sessionId, fd, worker) {
      worker.on('message', async (message) => {
          if (message.type === 'data') {
              this.emit('data', Buffer.from(message.buf), fd.session.id, fd.channelIndex);
          }
          if (message.type === 'error') {
              console.error(`Worker ${worker.pid} error --> ${message.error}`);
              this.cleanupConnection(sessionId);
          }
      });

      worker.on('error', (err) => {
          console.log(`Worker: ${worker.pid} --> Error:`, err);
          this.cleanupConnection(sessionId);
      });

      worker.on('exit', (code, signal) => {
          debug(`Worker: ${worker.pid} --> Exited, releasing session ${fd.session.id}, channel ${fd.channelIndex}`);
      });
  }

  cleanupConnection(sessionId) {
      debug(`Connection: ${sessionId} --> cleaning up.`);
      const [fd, worker] = this.workers.hasOwnProperty(sessionId) ? this.workers[sessionId] : [null, null];

      // Tell the streaming server controller to forward the session stop message to the broker
      if (fd) {
        this.emit('session-stop', fd.session, fd.channelIndex)
      }

      if (worker) {
          worker.kill();
      }

      if (sessionId && this.nms) {
        const session = this.nms.getSession(sessionId);
        if (session) {
          session.stop();
        }
      }

      if (this.workers.hasOwnProperty(sessionId)) {
        delete this.workers[sessionId];
      }
  }
}


module.exports = MultiplexedRTMPServer;
