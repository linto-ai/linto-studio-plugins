const { fork } = require('child_process');
const EventEmitter = require('eventemitter3');
const { CustomErrors, logger } = require("live-srt-lib");
const path = require('path');
const url = require('url');
const WebSocket = require('ws');

const {
    STREAMING_HOST,
    STREAMING_WS_TCP_PORT,
    STREAMING_WS_ENDPOINT
} = process.env;

// TODO: handle forced session stop (see SrtServer)
class MultiplexedWebsocketServer extends EventEmitter {
  constructor(app) {
    super();
    this.app = app;
    this.wss = null;
    this.workers = [];
    this.runningSessions = {}
  }

  // To verify incoming streamId and other details, controlled by streaming server forwarding from broker
  setSessions(sessions) {
      const prevSessions = this.sessions;
      this.sessions = sessions;

      if (prevSessions) {
          // force stop running sessions
          const deletedSessions = prevSessions.filter(currentSession =>
              !sessions.some(newSession => newSession.id === currentSession.id)
          );
          const sessionsToStop = deletedSessions.filter(deletedSession =>
              this.runningSessions.hasOwnProperty(deletedSession.id)
          );

          if (sessionsToStop.length > 0) {
              logger.debug(`Force cut the stream of sessions: ${sessionsToStop.map(s => s.id).join(", ")}`);
          }
          sessionsToStop.forEach(session => this.stopRunningSession(session));
      }
  }

  async start() {
      try {
          this.wss = new WebSocket.Server({ port: parseInt(STREAMING_WS_TCP_PORT), host: STREAMING_HOST});
          this.wss.on("connection", (ws, req) => {
              this.onConnection(ws, req);
          });
          logger.debug(`WS server started on ${STREAMING_HOST}:${STREAMING_WS_TCP_PORT}`);
      } catch (error) {
          logger.debug("Error starting WS server", error);
      }
  }

  stripStreamPrefix(streamId) {
      const prefix = `${STREAMING_WS_ENDPOINT}/`;

      if (streamId.startsWith(prefix)) {
          return streamId.slice(prefix.length);
      }
      return streamId;
  }

  addRunningSession(session, ws, fd, worker) {
    if (!this.runningSessions[session.id]) {
      this.runningSessions[session.id] = [];
    }

    this.runningSessions[session.id].push({ ws, fd, worker });
  }

  stopRunningSession(session) {
    while (this.runningSessions[session.id] && this.runningSessions[session.id].length > 0) {
      const { ws, fd, worker } = this.runningSessions[session.id][0];
      this.cleanupWebsocket(ws, fd, worker);
    }
  }

  async validateStream(req) {
    const streamId = this.stripStreamPrefix(req.url.substring(1))
    logger.debug(`Connection: ${req.url} --> Validating streamId ${streamId}`);

      // Extract sessionId and channelId from streamId
      const [sessionId, channelIndexStr] = streamId.split(",");
      const channelIndex = parseInt(channelIndexStr, 10);
      const session = this.sessions.find(s => s.id === sessionId);
      // Validate session
      if (!session) {
          logger.debug(`Connection: ${req.url} --> session ${sessionId} not found.`);
          return { isValid: false };
      }
      // Find channel by "id" key (do not rely on position in array that changes upon updates)
      const sortedChannels = session.channels.sort((a, b) => a.id - b.id);
      const channel = sortedChannels[channelIndex];
      if (!channel) {
          logger.debug(`Connection: ${req.url} --> session ${sessionId}, Channel id ${channelIndex} not found.`);
          return { isValid: false };
      }
      const channelId = channel.id;

      // Check if the channel's streamStatus is 'active'
      if (channel.streamStatus === 'active') {
          logger.debug(`Connection: ${req.url} --> session ${sessionId}, Channel id ${channelId} already active. Skipping.`);
          return { isValid: false };
      }
      // Check scheduleOn is after now
      const now = new Date();
      if (session.autoStart && session.scheduleOn && now < new Date(session.scheduleOn)) {
          logger.debug(`Connection: ${req.url} --> session ${sessionId}, scheduleOn in the future. Now: ${now}, scheduleOn: ${session.scheduleOn}. Skipping.`);
          return { isValid: false };
      }
      // Check endOn is before now
      if (session.autoEnd && session.endOn && now > new Date(session.endOn)) {
          logger.debug(`Connection: ${req.url} --> session ${sessionId}, endOn in the past. Now: ${now}, endOn: ${session.endOn}. Skipping.`);
          return { isValid: false };
      }

      logger.debug(`Connection: ${req.url} --> session ${sessionId}, channel ${channelId} is valid. Booting worker.`);
      return { isValid: true, session, channel };
  }

  async onConnection(ws, req) {
      logger.debug("Got new connection:", req.url);
      // New connection, validate stream
      const validation = await this.validateStream(req);
      if (!validation.isValid) {
          logger.debug(`Invalid stream: ${req.url}, voiding connection.`);
          this.cleanupWebsocket(ws, null, null);
          return;
      }

      // Stream is valid, store connection file descriptor
      const { channel, session } = validation;
      // Create a new file descriptor object to store connection details and session info
      const fd = {
          channel,
          session
      };

      let messageCallback = null;

      // handle websocket messages
      ws.on("message", (message) => {
          if (!messageCallback) {
              messageCallback = this.handleInitMessage(ws, message, fd);
              if (!messageCallback) {
                  this.cleanupWebsocket(ws);
              }
          }
          else {
              messageCallback(message);
          }
      });
  }

  handleInitMessage(ws, message, fd) {
    let initMessage;
    try {
        initMessage = JSON.parse(message);
    } catch (error) {
        logger.debug('Invalid JSON init message', error);
        ws.send(JSON.stringify({ type: 'error', message: `Invalid JSON init message: ${error}.` }));
        return null;
    }

    if (initMessage.type === 'init') {
        logger.debug(`Received configuration: sampleRate=${initMessage.sampleRate}, encoding=${initMessage.encoding}`);

        if(initMessage.encoding == 'pcm' && initMessage.sampleRate != 16000) {
            logger.debug(`Invalid sample rate: ${initMessage.sampleRate}`);
            ws.send(JSON.stringify({ type: 'error', message: `Invalid sample rate: ${initMessage.sampleRate}. Only 16000 is accepted.` }));
            return null
        }

        const callback = initMessage.encoding == 'pcm' ? this.initPcm(ws, fd) : this.initWorker(ws, fd);

        ws.send(JSON.stringify({ type: 'ack', message: 'Init done' }));

        return callback;
    } else {
        logger.debug('Invalid init message type');
        ws.send(JSON.stringify({ type: 'error', message: `Invalid init message type: ${initMessage.type}. It must be 'init'` }));
        return null;
    }
  }

  initPcm(ws, fd) {
      this.emit('session-start', fd.session, fd.channel);
      this.addRunningSession(fd.session, ws, fd, null);
      ws.on("close", () => {
          logger.debug(`Connection: ${ws} --> closed`);
          this.cleanupWebsocket(ws, fd);
      });
      ws.on("error", () => {
          logger.debug(`Connection: ${ws} --> error`);
          this.cleanupWebsocket(ws, fd);
      });
      return (message) => {
          this.emit('data', message, fd.session.id, fd.channel.id);
      };
  }

  initWorker(ws, fd) {
      // Start a new worker for this connection
      const worker = fork(path.join(__dirname, '../GstreamerWorker.js'), [], {
      });
      this.workers.push(worker);
      // Start gstreamer pipeline
      worker.send({ type: 'init' });


      // handle events
      this.handleWorkerEvents(ws, fd, worker);

      ws.on("close", () => {
          logger.debug(`Connection: ${ws} --> closed`);
          worker.send({ type: 'terminate' });
          this.cleanupWebsocket(ws, fd, worker);
      });
      ws.on("error", () => {
          logger.debug(`Connection: ${ws} --> error`);
          worker.send({ type: 'terminate' });
          this.cleanupWebsocket(ws, fd, worker);
      });

      // Acknowledge session for streaming server controller to handle further processing
      // - call scheduler to update session status to active
      // - start buffering audio in circular buffer
      // - start transcription
      this.emit('session-start', fd.session, fd.channel);
      this.addRunningSession(fd.session, ws, fd, worker);

      return (message) => {
          worker.send({ type: 'buffer', chunks: Buffer.from(new Int16Array(message))});
      };
  }

  // Events sent by the worker
  handleWorkerEvents(ws, fd, worker) {
      worker.on('message', async (message) => {
          if (message.type === 'data') {
              this.emit('data', message.buf, fd.session.id, fd.channel.id);
          }
          if (message.type === 'error') {
              logger.error(`Worker ${worker.pid} error --> ${message.error}`);
              this.cleanupWebsocket(ws, fd, worker);
          }
          if (message.type === 'playing') {
              logger.debug(`Worker: ${worker.pid} --> transcoding session ${fd.session.id}, channel ${fd.channel.id}`);
          }
      });

      worker.on('error', (err) => {
          logger.error(`Worker: ${worker.pid} --> Error:`, err);
          this.cleanupWebsocket(ws, fd, worker);
      });

      worker.on('exit', (code, signal) => {
          logger.debug(`Worker: ${worker.pid} --> Exited, releasing session ${fd.session.id}, channel ${fd.channel.id}`);
          this.cleanupWebsocket(ws, fd, worker);
      });
  }

  cleanupWebsocket(ws, fd, worker) {
      // Tell the streaming server controller to forward the session stop message to the broker
      if (fd) {
        this.emit('session-stop', fd.session, fd.channel.id)
      }

      logger.debug(`Connection: ${ws} --> cleaning up.`);
      if (ws) {
        if (ws.clients) {
          ws.clients.forEach(client => client.close());
        }
          ws.close();
          ws = null;
      }
      if (worker) {
          worker.kill();
          const workerIndex = this.workers.indexOf(worker);
          if (workerIndex > -1) {
              this.workers.splice(workerIndex, 1);
          }
      }

      if (fd && this.runningSessions[fd.session.id]) {
          this.runningSessions[fd.session.id] = this.runningSessions[fd.session.id].filter(item => item.fd.channel.id !== fd.channel.id);
          if (this.runningSessions[fd.session.id].length === 0) {
              delete this.runningSessions[fd.session.id];
          }
      }
  }
}


module.exports = MultiplexedWebsocketServer;
