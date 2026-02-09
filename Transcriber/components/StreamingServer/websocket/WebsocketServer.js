const { fork } = require('child_process');
const EventEmitter = require('eventemitter3');
const path = require('path');
const WebSocket = require('ws');
const logger = require('../../../logger')
const SpeakerTracker = require('../SpeakerTracker');

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
    this.speakerTrackers = new Map(); // sessionId_channelId -> SpeakerTracker
    this.isRunning = false;
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
              logger.info(`Force cut the stream of sessions: ${sessionsToStop.map(s => s.id).join(", ")}`);
          }
          sessionsToStop.forEach(session => this.stopRunningSession(session));
      }
  }

  async start() {
      if (this.isRunning) {
          logger.info(`WS server already running on ${STREAMING_HOST}:${STREAMING_WS_TCP_PORT}, skipping start`);
          return;
      }
      try {
          this.wss = new WebSocket.Server({ port: parseInt(STREAMING_WS_TCP_PORT), host: STREAMING_HOST});
          this.wss.on("connection", (ws, req) => {
              this.onConnection(ws, req);
          });
          this.isRunning = true;
          logger.info(`WS server started on ${STREAMING_HOST}:${STREAMING_WS_TCP_PORT}`);
      } catch (error) {
          logger.error("Error starting WS server", error);
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
    logger.info(`Connection: ${req.url} --> Validating streamId ${streamId}`);

      // Extract sessionId and channelId from streamId
      const [sessionId, channelIndexStr] = streamId.split(",");
      const channelIndex = parseInt(channelIndexStr, 10);
      const session = this.sessions.find(s => s.id === sessionId);
      // Validate session
      if (!session) {
          logger.warn(`Connection: ${req.url} --> session ${sessionId} not found.`);
          return { isValid: false };
      }
      // Find channel by "id" key (do not rely on position in array that changes upon updates)
      const sortedChannels = session.channels.sort((a, b) => a.id - b.id);
      const channel = sortedChannels[channelIndex];
      if (!channel) {
          logger.warn(`Connection: ${req.url} --> session ${sessionId}, Channel id ${channelIndex} not found.`);
          return { isValid: false };
      }
      const channelId = channel.id;

      // Check if the channel's streamStatus is 'active'
      if (channel.streamStatus === 'active') {
          logger.warn(`Connection: ${req.url} --> session ${sessionId}, Channel id ${channelId} already active. Skipping.`);
          return { isValid: false };
      }
      // Check scheduleOn is after now
      const now = new Date();
      if (session.autoStart && session.scheduleOn && now < new Date(session.scheduleOn)) {
          logger.warn(`Connection: ${req.url} --> session ${sessionId}, scheduleOn in the future. Now: ${now}, scheduleOn: ${session.scheduleOn}. Skipping.`);
          return { isValid: false };
      }
      // Check endOn is before now
      if (session.autoEnd && session.endOn && now > new Date(session.endOn)) {
          logger.warn(`Connection: ${req.url} --> session ${sessionId}, endOn in the past. Now: ${now}, endOn: ${session.endOn}. Skipping.`);
          return { isValid: false };
      }

      logger.info(`Connection: ${req.url} --> session ${sessionId}, channel ${channelId} is valid. Booting worker.`);
      return { isValid: true, session, channel };
  }

  async onConnection(ws, req) {
      logger.info("Got new connection:", req.url);
      // New connection, validate stream
      const validation = await this.validateStream(req);
      if (!validation.isValid) {
          logger.warn(`Invalid stream: ${req.url}, voiding connection.`);
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
        logger.warn('Invalid JSON init message', error);
        ws.send(JSON.stringify({ type: 'error', message: `Invalid JSON init message: ${error}.` }));
        return null;
    }

    if (initMessage.type === 'init') {
        logger.info(`Received configuration: sampleRate=${initMessage.sampleRate}, encoding=${initMessage.encoding}, diarizationMode=${initMessage.diarizationMode || 'asr'}`);

        if(initMessage.encoding == 'pcm' && initMessage.sampleRate != 16000) {
            logger.warn(`Invalid sample rate: ${initMessage.sampleRate}`);
            ws.send(JSON.stringify({ type: 'error', message: `Invalid sample rate: ${initMessage.sampleRate}. Only 16000 is accepted.` }));
            return null
        }

        // Store diarization mode and participants in file descriptor
        // Default is 'asr' for backward compatibility with other bots (Jitsi, BBB, Teams)
        fd.diarizationMode = initMessage.diarizationMode || 'asr';
        fd.participants = initMessage.participants || [];

        // Create SpeakerTracker for native diarization mode (LivekitBot)
        if (fd.diarizationMode === 'native') {
            const key = `${fd.session.id}_${fd.channel.id}`;
            const tracker = new SpeakerTracker();

            // Initialize with participants provided in init message
            for (const participant of fd.participants) {
                tracker.updateParticipant({ action: 'join', participant });
            }

            this.speakerTrackers.set(key, tracker);
            logger.info(`Native diarization enabled for session ${fd.session.id}, channel ${fd.channel.id} with ${fd.participants.length} initial participants`);
        }

        const callback = initMessage.encoding == 'pcm' ? this.initPcm(ws, fd) : this.initWorker(ws, fd);

        ws.send(JSON.stringify({ type: 'ack', message: 'Init done' }));
        logger.info(`Init ack sent for session ${fd.session.id}, channel ${fd.channel.id} (encoding=${initMessage.encoding})`);

        return callback;
    } else {
        logger.warn('Invalid init message type');
        ws.send(JSON.stringify({ type: 'error', message: `Invalid init message type: ${initMessage.type}. It must be 'init'` }));
        return null;
    }
  }

  initPcm(ws, fd) {
      // addRunningSession must be called BEFORE emitting session-start,
      // so that getDiarizationMode() can find the fd in runningSessions
      this.addRunningSession(fd.session, ws, fd, null);
      this.emit('session-start', fd.session, fd.channel);
      ws.on("close", (code, reason) => {
          logger.info(`WebSocket closed for session ${fd.session.id}, channel ${fd.channel.id} (code=${code}, reason=${reason || 'none'}, audioChunks=${audioMessageCount})`);
          this.cleanupWebsocket(ws, fd);
      });
      ws.on("error", (err) => {
          logger.error(`WebSocket error for session ${fd.session.id}, channel ${fd.channel.id}: ${err.message}`);
          this.cleanupWebsocket(ws, fd);
      });

      const key = `${fd.session.id}_${fd.channel.id}`;

      let audioMessageCount = 0;
      return (message) => {
          // Handle both binary audio and JSON metadata messages
          if (this.isJsonMessage(message)) {
              this.handleJsonMessage(fd, message);
          } else {
              // Binary audio data
              audioMessageCount++;
              this.emit('data', message, fd.session.id, fd.channel.id);
          }
      };
  }

  /**
   * Check if a message is JSON (starts with '{"')
   * We check for '{"' (0x7B 0x22) to avoid false positives with audio data
   * that might start with '{' by chance.
   */
  isJsonMessage(message) {
      if (Buffer.isBuffer(message) && message.length > 1) {
          // JSON object starts with '{"' (0x7B 0x22)
          return message[0] === 0x7B && message[1] === 0x22;
      }
      return false;
  }

  /**
   * Handle JSON messages (speaker changes, participant updates)
   */
  handleJsonMessage(fd, message) {
      const key = `${fd.session.id}_${fd.channel.id}`;
      const tracker = this.speakerTrackers.get(key);

      if (!tracker) {
          // Native diarization not enabled, ignore metadata
          return;
      }

      try {
          const data = JSON.parse(message.toString());

          switch (data.type) {
              case 'speakerChanged':
                  // Speaker change event from bot (only sent when speaker changes)
                  tracker.addSpeakerChange(data);
                  break;

              case 'participant':
                  // Participant join/leave notification
                  tracker.updateParticipant(data);
                  break;

              default:
                  logger.debug(`Unknown JSON message type: ${data.type}`);
          }
      } catch (error) {
          logger.warn(`Failed to parse JSON message: ${error.message}`);
      }
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
          logger.info(`Connection: ${ws} --> closed`);
          worker.send({ type: 'terminate' });
          this.cleanupWebsocket(ws, fd, worker);
      });
      ws.on("error", () => {
          logger.error(`Connection: ${ws} --> error`);
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
              logger.info(`Worker: ${worker.pid} --> transcoding session ${fd.session.id}, channel ${fd.channel.id}`);
          }
      });

      worker.on('error', (err) => {
          logger.error(`Worker: ${worker.pid} --> Error:`, err);
          this.cleanupWebsocket(ws, fd, worker);
      });

      worker.on('exit', (code, signal) => {
          logger.info(`Worker: ${worker.pid} --> Exited, releasing session ${fd.session.id}, channel ${fd.channel.id}`);
          this.cleanupWebsocket(ws, fd, worker);
      });
  }

  cleanupWebsocket(ws, fd, worker) {
      // Tell the streaming server controller to forward the session stop message to the broker
      if (fd) {
        this.emit('session-stop', fd.session, fd.channel.id)

        // Clean up SpeakerTracker for this session/channel
        const key = `${fd.session.id}_${fd.channel.id}`;
        if (this.speakerTrackers.has(key)) {
            this.speakerTrackers.get(key).clear();
            this.speakerTrackers.delete(key);
            logger.debug(`SpeakerTracker cleaned up for ${key}`);
        }
      }

      logger.info(`Connection: ${ws} --> cleaning up.`);
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

  /**
   * Get the SpeakerTracker for a session/channel (if native diarization is enabled)
   * @param {string} sessionId
   * @param {string} channelId
   * @returns {SpeakerTracker|null}
   */
  getSpeakerTracker(sessionId, channelId) {
      const key = `${sessionId}_${channelId}`;
      return this.speakerTrackers.get(key) || null;
  }

  /**
   * Get the diarization mode for a session/channel
   * @param {string} sessionId
   * @param {string} channelId
   * @returns {string} - 'native', 'asr', or 'none'
   */
  getDiarizationMode(sessionId, channelId) {
      // Look up from running sessions
      const sessions = this.runningSessions[sessionId];
      if (sessions) {
          const session = sessions.find(s => s.fd.channel.id === channelId);
          if (session) {
              return session.fd.diarizationMode || 'asr';
          }
      }
      return 'asr';
  }
}


module.exports = MultiplexedWebsocketServer;
