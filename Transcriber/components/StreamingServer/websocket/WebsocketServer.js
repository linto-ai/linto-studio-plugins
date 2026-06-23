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

// WebSocket runs over TCP. Unlike SRT (UDP) there is no inactivity sentinel:
// the connection lifetime is governed by the TCP socket alone. ws.on('close')
// fires when the peer sends FIN or the OS detects an RST; ws.on('error') for
// all other faults. Until then the channel is considered live, even if the
// client has gone silent. For pause/resume this means:
//   - WS pause + sender keeps the socket open and silent → ASR stays alive
//     (just paused), resume is immediate on the same provider.
//   - WS pause + sender closes the socket → ws.on('close') triggers cleanup,
//     emits session-stop, ASR is disposed. A subsequent PUT /resume finds
//     no ASR. Streaming has to start over.
// See doc/streaming-protocols.md for the cross-protocol comparison.
class MultiplexedWebsocketServer extends EventEmitter {
  constructor(app) {
    super();
    this.app = app;
    this.wss = null;
    this.workers = [];
    this.runningSessions = {}
    this.runningChannels = {};
    this.pendingChannels = new Set();
    this.isRunning = false;
    // Native diarization: per-channel SpeakerTracker, created on `init` when a
    // bot announces diarizationMode='native'. Keyed by `${sessionId}_${channelId}`.
    this.speakerTrackers = new Map();
    // Periodic reaper: drops trackers whose channel is no longer running (orphans
    // that escaped cleanupWebsocket). Held so stop()/tests can clear it.
    this.reaperInterval = null;
    this.reaperIntervalMs = 60000;
  }

  // Drop trackers whose channel is no longer in runningChannels. A live tracker
  // is only valid while its channel streams; an entry for a channel that is gone
  // is an orphan that cleanupWebsocket missed (e.g. an init that failed without
  // an fd). Safe to call repeatedly.
  reapOrphanTrackers() {
    for (const key of this.speakerTrackers.keys()) {
      // key is `${sessionId}_${channelId}`; channelId is the last segment.
      const channelId = key.slice(key.lastIndexOf('_') + 1);
      if (!this.runningChannels[channelId]) {
        logger.info(`Reaping orphan speaker tracker for channel ${channelId} (key ${key})`);
        this.speakerTrackers.delete(key);
      }
    }
  }

  startReaper() {
    if (this.reaperInterval) return;
    this.reaperInterval = setInterval(() => this.reapOrphanTrackers(), this.reaperIntervalMs);
    // Do not keep the event loop alive solely for the reaper.
    if (this.reaperInterval.unref) this.reaperInterval.unref();
  }

  stopReaper() {
    if (this.reaperInterval) {
      clearInterval(this.reaperInterval);
      this.reaperInterval = null;
    }
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
          this.startReaper();
          logger.info(`WS server started on ${STREAMING_HOST}:${STREAMING_WS_TCP_PORT}`);
      } catch (error) {
          logger.error("Error starting WS server", error);
      }
  }

  async stop() {
      this.stopReaper();
      if (this.wss) {
          this.wss.close();
          this.wss = null;
      }
      this.isRunning = false;
      logger.info("WS server stopped");
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
    this.runningChannels[fd.channel.id] = { ws, fd, worker };
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

      // Guard against concurrent connection setup for same channel
      if (this.pendingChannels.has(channelId)) {
          logger.warn(`Connection: ${req.url} --> session ${sessionId}, Channel id ${channelId} connection already pending. Skipping.`);
          return { isValid: false };
      }

      // Check local state (reliable) instead of cached global state (stale)
      let needsLocalCleanup = false;
      if (this.runningChannels[channelId]) {
          logger.warn(`Connection: ${req.url} --> session ${sessionId}, Channel id ${channelId} already running locally. Will replace existing connection.`);
          needsLocalCleanup = true;
      } else if (channel.streamStatus === 'active') {
          logger.warn(`Connection: ${req.url} --> session ${sessionId}, Channel id ${channelId} marked active elsewhere (stale cache). Accepting reconnection.`);
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
      return { isValid: true, session, channel, needsLocalCleanup };
  }

  async onConnection(ws, req) {
      logger.info("Got new connection:", req.url);
      const validation = await this.validateStream(req);
      if (!validation.isValid) {
          logger.warn(`Invalid stream: ${req.url}, voiding connection.`);
          this.cleanupWebsocket(ws, null, null);
          return;
      }

      const { channel, session, needsLocalCleanup } = validation;

      this.pendingChannels.add(channel.id);
      try {
          if (needsLocalCleanup) {
              const existing = this.runningChannels[channel.id];
              if (existing) {
                  logger.warn(`Replacing existing connection for channel ${channel.id}`, {sessionId: session.id, channelId: channel.id});
                  this.cleanupWebsocket(existing.ws, existing.fd, existing.worker);
              }
          }

          const fd = { channel, session };
          let messageCallback = null;

          ws.on("message", (message) => {
              if (!messageCallback) {
                  messageCallback = this.handleInitMessage(ws, message, fd);
                  if (!messageCallback) {
                      this.cleanupWebsocket(ws);
                  }
              } else {
                  messageCallback(message);
              }
          });
      } finally {
          this.pendingChannels.delete(channel.id);
      }
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

        // Native diarization (bot streams): set up the SpeakerTracker BEFORE
        // initPcm() emits 'session-start', so the StreamingServer can hand it to
        // the ASR as it is created. Must run before the callback is built.
        fd.diarizationMode = initMessage.diarizationMode || 'asr';
        const trackerKey = `${fd.session.id}_${fd.channel.id}`;
        if (fd.diarizationMode === 'native') {
            const tracker = new SpeakerTracker();
            for (const participant of (initMessage.participants || [])) {
                tracker.updateParticipant({ action: 'join', participant });
            }
            this.speakerTrackers.set(trackerKey, tracker);
            logger.info(`Native diarization enabled for session ${fd.session.id}, channel ${fd.channel.id} (${(initMessage.participants || []).length} initial participants)`);
        }

        // Any failure AFTER the tracker is registered must drop it, otherwise the
        // entry leaks: cleanupWebsocket only runs for callbacks it was given an
        // fd for, and the null-return path in onConnection calls it without fd.
        let callback;
        try {
            callback = initMessage.encoding == 'pcm' ? this.initPcm(ws, fd) : this.initWorker(ws, fd);
        } catch (error) {
            logger.error(`Init failed for session ${fd.session.id}, channel ${fd.channel.id}`, error);
            this.speakerTrackers.delete(trackerKey);
            ws.send(JSON.stringify({ type: 'error', message: `Init failed: ${error}.` }));
            return null;
        }
        if (!callback) {
            this.speakerTrackers.delete(trackerKey);
            return null;
        }

        ws.send(JSON.stringify({ type: 'ack', message: 'Init done' }));

        return callback;
    } else {
        logger.warn('Invalid init message type');
        ws.send(JSON.stringify({ type: 'error', message: `Invalid init message type: ${initMessage.type}. It must be 'init'` }));
        return null;
    }
  }

  initPcm(ws, fd) {
      this.emit('session-start', fd.session, fd.channel);
      this.addRunningSession(fd.session, ws, fd, null);
      ws.on("close", () => {
          logger.info(`Connection: ${ws} --> closed`);
          this.cleanupWebsocket(ws, fd);
      });
      ws.on("error", () => {
          logger.error(`Connection: ${ws} --> error`);
          this.cleanupWebsocket(ws, fd);
      });
      return (message) => {
          // A bot stream interleaves binary PCM with JSON control messages
          // (speakerChanged / participant) for native diarization. Distinguish
          // them robustly: only treat a frame as control if it both *looks* like
          // JSON ({") and parses to a recognized control type; otherwise it is
          // PCM (a PCM sample can coincidentally start with 0x7B 0x22, so a parse
          // failure must fall through to audio rather than drop the frame).
          if (this.handleControlMessage(fd, message)) return;
          this.emit('data', message, fd.session.id, fd.channel.id);
      };
  }

  // Returns true if the message was consumed as a native-diarization control
  // message, false if it should be treated as audio data.
  handleControlMessage(fd, message) {
      if (fd.diarizationMode !== 'native') return false;
      if (!Buffer.isBuffer(message) || message.length < 2) return false;
      if (message[0] !== 0x7B || message[1] !== 0x22) return false; // not '{"'
      let data;
      try {
          data = JSON.parse(message.toString());
      } catch (e) {
          return false; // PCM that merely started with 0x7B22
      }
      const tracker = this.speakerTrackers.get(`${fd.session.id}_${fd.channel.id}`);
      if (!tracker) return false;
      if (data.type === 'speakerChanged') {
          tracker.addSpeakerChange(data);
          return true;
      }
      if (data.type === 'participant') {
          tracker.updateParticipant(data);
          return true;
      }
      return false;
  }

  getSpeakerTracker(sessionId, channelId) {
      return this.speakerTrackers.get(`${sessionId}_${channelId}`) || null;
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
      if (fd && this.runningChannels[fd.channel.id]) {
          delete this.runningChannels[fd.channel.id];
      }
      if (fd) {
          // Drop the map reference (a reconnect gets a fresh tracker) but do NOT
          // clear() it synchronously: session-stop triggers an async ASR flush
          // (flushFinals) whose trailing finals still read this tracker to stamp
          // their speaker. The ASR holds the reference; GC reclaims it after dispose.
          this.speakerTrackers.delete(`${fd.session.id}_${fd.channel.id}`);
      }
  }
}


module.exports = MultiplexedWebsocketServer;
