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

// TODO: handle forced session stop (see SrtServer)
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

      // Extract sessionId and channelId from streamId
      const channelIndex = parseInt(channelIndexStr, 10);
      const session = this.sessions.find(s => s.id === sessionId);
      // Validate session
      if (!session) {
          debug(`Connection: ${streamPath} --> session ${sessionId} not found.`);
          return { isValid: false };
      }
      // Find channel by "id" key (do not rely on position in array that changes upon updates)
      const sortedChannels = session.channels.sort((a, b) => a.id - b.id);
      const channel = sortedChannels[channelIndex];
      if (!channel) {
          debug(`Connection: ${streamPath} --> session ${sessionId}, Channel id ${channelIndex} not found.`);
          return { isValid: false };
      }
      const channelId = channel.id;

      // Check if the channel's streamStatus is 'active'
      if (channel.streamStatus === 'active') {
          debug(`Connection: ${streamPath} --> session ${sessionId}, Channel id ${channelId} already active. Skipping.`);
          return { isValid: false };
      }
      // Check scheduleOn is after now
      const now = new Date();
      if (session.autoStart && session.scheduleOn && now < new Date(session.scheduleOn)) {
          debug(`Connection: ${streamPath} --> session ${sessionId}, scheduleOn in the future. Now: ${now}, scheduleOn: ${session.scheduleOn}. Skipping.`);
          return { isValid: false };
      }
      // Check endOn is before now
      if (session.autoEnd && session.endOn && now > new Date(session.endOn)) {
          debug(`Connection: ${streamPath} --> session ${sessionId}, endOn in the past. Now: ${now}, endTime: ${session.endOn}. Skipping.`);
          return { isValid: false };
      }

      debug(`Connection: ${streamPath} --> session ${sessionId}, channel ${channelId} is valid. Booting worker.`);
      return { isValid: true, sessionId, channelId, session };
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
      const { channelId, session } = validation;
      // Create a new file descriptor object to store connection details and session info
      const fd = {
          channelId,
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
      this.emit('session-start', fd.session, fd.channelId);
  }

  // Events sent by the worker
  handleWorkerEvents(sessionId, fd, worker) {
      worker.on('message', async (message) => {
          if (message.type === 'data') {
              this.emit('data', Buffer.from(message.buf), fd.session.id, fd.channelId);
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
          debug(`Worker: ${worker.pid} --> Exited, releasing session ${fd.session.id}, channel ${fd.channelId}`);
      });
  }

  cleanupConnection(sessionId) {
      debug(`Connection: ${sessionId} --> cleaning up.`);
      const [fd, worker] = this.workers.hasOwnProperty(sessionId) ? this.workers[sessionId] : [null, null];

      // Tell the streaming server controller to forward the session stop message to the broker
      if (fd) {
        this.emit('session-stop', fd.session, fd.channelId)
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
