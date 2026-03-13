const { fork } = require('child_process');
const EventEmitter = require('eventemitter3');
const NodeMediaServer = require('node-media-server');
const logger = require('../../../logger')
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
    this.runningSessions = {};
    this.runningChannels = {};
    this.pendingChannels = new Set();
    this.channelTimeoutSeconds = 5;
    this.isRunning = false;

    setInterval(() => {
        this.checkTimedOutChannel();
    }, 1000);
  }

  setSessions(sessions) {
      const prevSessions = this.sessions;
      this.sessions = sessions;

      if (prevSessions) {
          const deletedSessions = prevSessions.filter(currentSession =>
              !sessions.some(newSession => newSession.id === currentSession.id)
          );
          const sessionsToStop = deletedSessions.filter(deletedSession =>
              this.runningSessions.hasOwnProperty(deletedSession.id)
          );
          if (sessionsToStop.length > 0) {
              logger.warn(`Force cut the stream of sessions: ${sessionsToStop.map(s => s.id).join(", ")}`);
          }
          sessionsToStop.forEach(session => this.stopRunningSession(session));
      }
  }

  addRunningSession(session, nmsSessionId, fd, worker) {
      if (!this.runningSessions[session.id]) {
          this.runningSessions[session.id] = [];
      }
      this.runningSessions[session.id].push({ nmsSessionId, fd, worker });
      this.runningChannels[fd.channel.id] = { nmsSessionId, fd, worker, lastPacket: Date.now() };
  }

  stopRunningSession(session) {
      while (this.runningSessions[session.id] && this.runningSessions[session.id].length > 0) {
          const { nmsSessionId } = this.runningSessions[session.id][0];
          this.cleanupConnection(nmsSessionId);
      }
  }

  checkTimedOutChannel() {
      const now = Date.now();
      for (const value of Object.values(this.runningChannels)) {
          if (now - value.lastPacket > this.channelTimeoutSeconds * 1000) {
              logger.warn('Channel timeout, closing!', {sessionId: value.fd.session.id, channelId: value.fd.channel.id});
              this.cleanupConnection(value.nmsSessionId);
          }
      }
  }

  async start() {
      if (this.isRunning) {
          logger.info(`RTMP server already running on ${STREAMING_HOST}:${STREAMING_RTMP_TCP_PORT}, skipping start`);
          return;
      }
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
          this.isRunning = true;
          logger.info(`RTMP server started on ${STREAMING_HOST}:${STREAMING_RTMP_TCP_PORT}`);
      } catch (error) {
          logger.error("Error starting RTMP server", error);
      }
  }

  async validateStream(streamPath) {
    const [sessionId, channelIndexStr] = streamPath.split('/').filter(element => element !== "")
    logger.info(`Connection: ${streamPath} --> Validating streamId ${streamPath}`);

      // Extract sessionId and channelId from streamId
      const channelIndex = parseInt(channelIndexStr, 10);
      const session = this.sessions.find(s => s.id === sessionId);
      // Validate session
      if (!session) {
          logger.warn(`Connection: ${streamPath} --> session ${sessionId} not found.`);
          return { isValid: false };
      }
      // Find channel by "id" key (do not rely on position in array that changes upon updates)
      const sortedChannels = session.channels.sort((a, b) => a.id - b.id);
      const channel = sortedChannels[channelIndex];
      if (!channel) {
          logger.warn(`Connection: ${streamPath} --> session ${sessionId}, Channel id ${channelIndex} not found.`);
          return { isValid: false };
      }
      const channelId = channel.id;

      // Guard against concurrent connection setup for same channel
      if (this.pendingChannels.has(channelId)) {
          logger.warn(`Connection: ${streamPath} --> session ${sessionId}, Channel id ${channelId} connection already pending. Skipping.`);
          return { isValid: false };
      }

      // Check local state (reliable) instead of cached global state (stale)
      let needsLocalCleanup = false;
      if (this.runningChannels[channelId]) {
          logger.warn(`Connection: ${streamPath} --> session ${sessionId}, Channel id ${channelId} already running locally. Will replace existing connection.`);
          needsLocalCleanup = true;
      } else if (channel.streamStatus === 'active') {
          logger.warn(`Connection: ${streamPath} --> session ${sessionId}, Channel id ${channelId} marked active elsewhere (stale cache). Accepting reconnection.`);
      }
      // Check scheduleOn is after now
      const now = new Date();
      if (session.autoStart && session.scheduleOn && now < new Date(session.scheduleOn)) {
          logger.warn(`Connection: ${streamPath} --> session ${sessionId}, scheduleOn in the future. Now: ${now}, scheduleOn: ${session.scheduleOn}. Skipping.`);
          return { isValid: false };
      }
      // Check endOn is before now
      if (session.autoEnd && session.endOn && now > new Date(session.endOn)) {
          logger.warn(`Connection: ${streamPath} --> session ${sessionId}, endOn in the past. Now: ${now}, endTime: ${session.endOn}. Skipping.`);
          return { isValid: false };
      }

      logger.info(`Connection: ${streamPath} --> session ${sessionId}, channel ${channelId} is valid. Booting worker.`);
      return { isValid: true, session, channel, needsLocalCleanup };
  }

  async onConnection(nmsSessionId, streamPath) {
      logger.info("Got new connection:", streamPath);
      const validation = await this.validateStream(streamPath);
      if (!validation.isValid) {
          logger.warn(`Invalid stream: ${streamPath}, voiding connection.`);
          this.cleanupConnection(nmsSessionId);
          return;
      }

      const { channel, session, needsLocalCleanup } = validation;

      this.pendingChannels.add(channel.id);
      try {
          if (needsLocalCleanup) {
              const existing = this.runningChannels[channel.id];
              if (existing) {
                  logger.warn(`Replacing existing connection for channel ${channel.id}`, {sessionId: session.id, channelId: channel.id});
                  this.cleanupConnection(existing.nmsSessionId);
              }
          }

          const fd = { channel, session };
          const worker = fork(path.join(__dirname, '../GstreamerWorker.js'), []);
          this.workers[nmsSessionId] = [fd, worker];
          worker.send({ type: 'init', streamPath: streamPath });
          this.handleWorkerEvents(nmsSessionId, fd, worker);
          this.emit('session-start', fd.session, fd.channel);
          this.addRunningSession(session, nmsSessionId, fd, worker);
      } finally {
          this.pendingChannels.delete(channel.id);
      }
  }

  // Events sent by the worker
  handleWorkerEvents(nmsSessionId, fd, worker) {
      worker.on('message', async (message) => {
          if (message.type === 'data') {
              this.emit('data', Buffer.from(message.buf), fd.session.id, fd.channel.id);
              if (this.runningChannels[fd.channel.id]) {
                  this.runningChannels[fd.channel.id].lastPacket = Date.now();
              }
          }
          if (message.type === 'error') {
              logger.error(`Worker ${worker.pid} error --> ${message.error}`);
              this.cleanupConnection(nmsSessionId);
          }
      });

      worker.on('error', (err) => {
          logger.error(`Worker: ${worker.pid} --> Error:`, err);
          this.cleanupConnection(nmsSessionId);
      });

      worker.on('exit', (code, signal) => {
          logger.info(`Worker: ${worker.pid} --> Exited, releasing session ${fd.session.id}, channel ${fd.channel.id}`);
      });
  }

  cleanupConnection(nmsSessionId) {
      logger.info(`Connection: ${nmsSessionId} --> cleaning up.`);
      const [fd, worker] = this.workers.hasOwnProperty(nmsSessionId) ? this.workers[nmsSessionId] : [null, null];

      if (fd) {
          this.emit('session-stop', fd.session, fd.channel.id);
      }

      if (worker) {
          worker.kill();
      }

      if (nmsSessionId && this.nms) {
          const session = this.nms.getSession(nmsSessionId);
          if (session) {
              session.stop();
          }
      }

      if (this.workers.hasOwnProperty(nmsSessionId)) {
          delete this.workers[nmsSessionId];
      }

      if (fd && this.runningSessions[fd.session.id]) {
          this.runningSessions[fd.session.id] = this.runningSessions[fd.session.id].filter(
              item => item.fd.channel.id !== fd.channel.id
          );
          if (this.runningSessions[fd.session.id].length === 0) {
              delete this.runningSessions[fd.session.id];
          }
      }
      if (fd && this.runningChannels[fd.channel.id]) {
          delete this.runningChannels[fd.channel.id];
      }
  }
}


module.exports = MultiplexedRTMPServer;
