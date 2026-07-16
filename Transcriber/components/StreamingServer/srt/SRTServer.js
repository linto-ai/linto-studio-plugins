const EventEmitter = require('eventemitter3');
const { SRT, SRTServer, AsyncSRT } = require("linto-node-srt");
const { fork } = require('child_process');
const path = require('path');
const logger = require('../../../logger')

const {
    STREAMING_PASSPHRASE,
    STREAMING_HOST,
    STREAMING_SRT_UDP_PORT,
    STREAMING_SRT_PAYLOAD_TIMEOUT_SECONDS,
} = process.env;

// node-srt's readChunks() takes onRead as its 3rd positional argument, so passing
// it means restating the first two. These mirror the binding's own defaults
// (linto-node-srt/src/async-reader-writer.js) — keep them in sync on upgrade.
const SRT_READ_MIN_BYTES = 1316;
const SRT_READ_BUF_SIZE = 16 * 1024;

class MultiplexedSRTServer extends EventEmitter {
    constructor(app) {
        super();
        this.app = app;
        this.workers = []; // Workers for SRT connections (gstreamer)
        this.asyncSrtServer = null;
        this.runningSessions = {}
        this.runningChannels = {}
        this.pendingChannels = new Set();
        this.asyncSrtHelper = new AsyncSRT(); // Shared instance for socket option reads (validateStream)
        // Our own connection listeners, so cleanup can remove exactly ours and leave
        // node-srt's internal 'closing' handler in place — that handler is the only
        // thing that evicts the fd from the server's _connectionMap (srt-server.js).
        this.connectionHandlers = new WeakMap();
        this.cleanedConnections = new WeakSet();
        // SRT runs over UDP. Unlike WS/RTMP (TCP), there is no FIN/RST when a
        // sender stops streaming, so we have to detect inactivity ourselves:
        // if no SRT packet has been observed for `channelTimeoutSeconds`, we
        // assume the sender is gone and tear the connection down. Trade-off:
        //   - too short → benign jitter cuts the stream and forces a new ASR
        //                 (segmentId is preserved via lastSegmentIds map)
        //   - too long  → resources held for a sender that will never return
        // See doc/streaming-protocols.md for the pause/resume impact.
        this.channelTimeoutSeconds = 5;
        // Second, independent predicate: a socket can keep waking us up while
        // delivering zero payload (see checkTimedOutChannel). Must stay well above
        // channelTimeoutSeconds so the ordinary sender-gone path fires first and the
        // logs attribute correctly. SRTO_RCVLATENCY is never set, so libsrt's live
        // default of 120 ms governs any legitimate TSBPD hold — 15 s is a wide margin.
        this.payloadTimeoutSeconds = parseInt(STREAMING_SRT_PAYLOAD_TIMEOUT_SECONDS, 10) || 15;
        this.isRunning = false;

        this.checkInterval = setInterval(() => {
            this.checkTimedOutChannel();
        }, 1000);
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
                logger.warn(`Force cut the stream of sessions: ${sessionsToStop.map(s => s.id).join(", ")}`);
            }
            sessionsToStop.forEach(session => this.stopRunningSession(session));
        }
    }

    // Per-channel sentinel, two independent predicates.
    //
    // 1. `lastEvent` — no socket event at all for `channelTimeoutSeconds`. SRT runs
    //    over UDP, so unlike WS/RTMP (TCP) there is no FIN/RST when a sender stops;
    //    silence is the only signal that it is gone. WS and RTMP have no equivalent
    //    because the server reacts to their close/error events. For pause/resume:
    //      - SRT pause + sender keeps streaming → packets keep arriving,
    //        lastEvent stays fresh, no timeout, ASR restart on resume is
    //        immediate (same provider).
    //      - SRT pause + sender stops streaming → after channelTimeoutSeconds
    //        the connection is torn down and the ASR is disposed. A subsequent
    //        PUT /resume finds no ASR. Streaming has to start over (a new
    //        SRT connect emits session-start and a fresh ASR is created with
    //        the segmentId carried over via lastSegmentIds).
    //
    // 2. `lastPayload` — events keep firing but no payload byte is delivered. This
    //    is the wedge signature: libsrt's TSBPD clock can be displaced far into the
    //    future, after which it accepts packets but delivers none, forever, on that
    //    one socket. Event-fresh + payload-stale cannot mean "sender gone" (that
    //    trips predicate 1 first), so by construction it means the socket is wedged.
    //    Counting SRT payload bytes — not transcription — is what makes this safe:
    //    a silent room still runs an encoder emitting a continuous packet stream.
    //    Both predicates route to the same teardown, which is the recovery validated
    //    in production (a new caller then gets a fresh socket).
    checkTimedOutChannel() {
        const now = Date.now();
        for (const value of Object.values(this.runningChannels)) {
            const logMeta = {sessionId: value.fd.session.id, channelId: value.fd.channel.id};
            if (now - value.lastEvent > this.channelTimeoutSeconds * 1000) {
                logger.warn('Channel timeout, closing !', logMeta);
                this.cleanupConnection(value.connection, value.fd, value.worker);
                continue;
            }
            if (now - value.lastPayload > this.payloadTimeoutSeconds * 1000) {
                const stalledFor = Math.round((now - value.lastPayload) / 1000);
                logger.warn(`Channel stalled: socket still signalling but no SRT payload for ${stalledFor}s, closing !`, logMeta);
                this.cleanupConnection(value.connection, value.fd, value.worker);
            }
        }
    }

    async start() {
        if (this.isRunning) {
            logger.info(`SRT server already running on ${STREAMING_HOST}:${STREAMING_SRT_UDP_PORT}, skipping start`);
            return;
        }
        try {
            this.asyncSrtServer = new SRTServer(parseInt(STREAMING_SRT_UDP_PORT), STREAMING_HOST);
            this.asyncSrtServer.on("connection", (connection) => {
                this.onConnection(connection);
            });
            this.server = await this.asyncSrtServer.create();
            // Check if STREAMING_PASSPHRASE is set and apply it along with key length
            const hasPassphrase = STREAMING_PASSPHRASE && STREAMING_PASSPHRASE.length > 0 && STREAMING_PASSPHRASE !== 'false';
            if (hasPassphrase) {
                let keyLength = STREAMING_PASSPHRASE.length >= 32 ? 32 : (STREAMING_PASSPHRASE.length >= 24 ? 24 : 16);
                await this.server.setSocketFlags([SRT.SRTO_PASSPHRASE, SRT.SRTO_PBKEYLEN], [STREAMING_PASSPHRASE, keyLength]);
            }
            this.server.open();
            this.isRunning = true;
            // log passphrase if set
            logger.info(`SRT server started on ${STREAMING_HOST}:${STREAMING_SRT_UDP_PORT} ${hasPassphrase ? 'with passphrase' : ''}`);
        } catch (error) {
            logger.error("Error starting SRT server", error);
        }
    }

    async validateStream(connection) {
        const streamId = await this.asyncSrtHelper.getSockOpt(connection.fd, SRT.SRTO_STREAMID);
        logger.info(`Connection: ${connection.fd} --> Validating streamId ${streamId}`);

        // Extract sessionId and channelId from streamId
        const [sessionId, channelIndexStr] = streamId.split(",");
        const channelIndex = parseInt(channelIndexStr, 10);
        const session = this.sessions.find(s => s.id === sessionId);
        // Validate session
        if (!session) {
            logger.warn(`Connection: ${connection.fd} --> session ${sessionId} not found.`);
            return { isValid: false };
        }
        // Find channel by index in array, it is recomputed at each update and ordered by id and starting at 0
        const sortedChannels = session.channels.sort((a, b) => a.id - b.id);
        const channel = sortedChannels[channelIndex];
        if (!channel) {
            logger.warn(`Connection: ${connection.fd} --> session ${sessionId}, Channel id ${channelIndex} not found.`);
            return { isValid: false };
        }
        const channelId = channel.id;

        // Guard against concurrent connection setup for same channel
        if (this.pendingChannels.has(channelId)) {
            logger.warn(`Connection: ${connection.fd} --> session ${sessionId}, Channel id ${channelId} connection already pending. Skipping.`);
            return { isValid: false };
        }

        // Check local state (reliable) instead of cached global state (stale)
        let needsLocalCleanup = false;
        if (this.runningChannels[channelId]) {
            logger.warn(`Connection: ${connection.fd} --> session ${sessionId}, Channel id ${channelId} already running locally. Will replace existing connection.`);
            needsLocalCleanup = true;
        } else if (channel.streamStatus === 'active') {
            logger.warn(`Connection: ${connection.fd} --> session ${sessionId}, Channel id ${channelId} marked active elsewhere (stale cache). Accepting reconnection.`);
        }
        // Check scheduleOn is after now
        const now = new Date();
        if (session.autoStart && session.scheduleOn && now < new Date(session.scheduleOn)) {
            logger.warn(`Connection: ${connection.fd} --> session ${sessionId}, scheduleOn in the future. Now: ${now}, scheduleOn: ${session.scheduleOn}. Skipping.`);
            return { isValid: false };
        }
        // Check endOn is before now
        if (session.autoEnd && session.endOn && now > new Date(session.endOn)) {
            logger.warn(`Connection: ${connection.fd} --> session ${sessionId}, endOn in the past. Now: ${now}, endOn: ${session.endOn}. Skipping.`);
            return { isValid: false };
        }

        logger.info(`Connection: ${connection.fd} --> session ${sessionId}, channel ${channelId} is valid. Booting worker.`);
        return { isValid: true, session, channel, needsLocalCleanup };
    }

    async onConnection(connection) {
        logger.info("Got new connection:", connection.fd);
        const validation = await this.validateStream(connection);
        if (!validation.isValid) {
            logger.warn(`Invalid stream: ${connection.fd}, voiding connection.`);
            connection.close();
            connection = null;
            return;
        }
        const { channel, session, needsLocalCleanup } = validation;

        this.pendingChannels.add(channel.id);
        try {
            if (needsLocalCleanup) {
                const existing = this.runningChannels[channel.id];
                if (existing) {
                    logger.warn(`Replacing existing connection for channel ${channel.id}`, {sessionId: session.id, channelId: channel.id});
                    this.cleanupConnection(existing.connection, existing.fd, existing.worker);
                }
            }

            const fd = { channel, session };
            const worker = fork(path.join(__dirname, '../GstreamerWorker.js'), []);
            this.workers.push(worker);
            worker.send({ type: 'init' });
            // Cache the ReaderWriter to avoid creating a new native-bound object on every data event
            const readerWriter = connection.getReaderWriter();
            this.handleWorkerEvents(connection, fd, worker);
            this.handleConnectionEvents(connection, fd, worker, readerWriter);
            logger.info(`Session ${session.name} starts.`, {sessionId: session.id, channelId: channel.id});
            this.emit('session-start', fd.session, fd.channel);
            this.addRunningSession(session, connection, fd, worker);
        } finally {
            this.pendingChannels.delete(channel.id);
        }
    }

    addRunningSession(session, connection, fd, worker) {
      if (!this.runningSessions[session.id]) {
        this.runningSessions[session.id] = [];
      }

      this.runningSessions[session.id].push({ connection, fd, worker });

      const now = Date.now();
      this.runningChannels[fd.channel.id] = { connection, fd, worker, lastEvent: now, lastPayload: now };
    }

    stopRunningSession(session) {
      while (this.runningSessions[session.id] && this.runningSessions[session.id].length > 0) {
        const { connection, fd, worker } = this.runningSessions[session.id][0];
        this.cleanupConnection(connection, fd, worker);
      }
    }

    getLogMeta(fd) {
        const logMeta = {};
        if (fd && fd.session && fd.session.id) {
            logMeta.sessionId = fd.session.id;
        }
        if (fd && fd.channel && fd.channel.id) {
            logMeta.channelId = fd.channel.id;
        }
        return logMeta;
    }

    // Events sent by the worker
    handleWorkerEvents(connection, fd, worker) {
        const logMeta = this.getLogMeta(fd);

        worker.on('message', async (message) => {
            if (message.type === 'data') {
                this.emit('data', message.buf, fd.session.id, fd.channel.id);
            }
            if (message.type === 'error') {
                logger.error(`Worker ${worker.pid} error --> ${message.error}`, logMeta);
                this.cleanupConnection(connection, fd, worker);
            }
            if (message.type === 'playing') {
                logger.info(`Worker: ${worker.pid} --> transcoding`, logMeta);
            }
        });

        worker.on('error', (err) => {
            logger.error(`Worker: ${worker.pid} --> Error:`, logMeta, err);
            this.cleanupConnection(connection, fd, worker);
        });

        worker.on('exit', (code, signal) => {
            logger.info(`Worker: ${worker.pid} --> Exited, releasing session`, logMeta);
        });
    }


    handleConnectionEvents(connection, fd, worker, readerWriter) {
        const logMeta = this.getLogMeta(fd);

        // Named so cleanupConnection can remove exactly these and leave node-srt's
        // own listeners alone.
        const handlers = {
            data: async () => {
                // A wakeup only proves libsrt signalled the fd, not that audio arrived —
                // lastPayload is bumped from onClientData, on bytes actually read.
                if (this.runningChannels[fd.channel.id]) {
                    this.runningChannels[fd.channel.id].lastEvent = Date.now();
                }
                if (worker && worker.connected) {
                    this.onClientData(readerWriter, fd, worker, connection);
                }
            },
            closing: async () => {
                logger.info(`Connection: ${connection.fd} --> closing`, logMeta);
                connection.close()
            },
            closed: async () => {
                logger.info(`Connection: ${connection.fd} --> closed`, logMeta);
                if (worker && worker.connected) {
                    worker.send({ type: 'terminate' });
                }
                this.cleanupConnection(connection, fd, worker);
            },
            error: (err) => {
                logger.error(`Connection: ${connection.fd} --> error:`, logMeta, err);
                this.cleanupConnection(connection, fd, worker);
            },
        };

        for (const [event, handler] of Object.entries(handlers)) {
            connection.on(event, handler);
        }
        this.connectionHandlers.set(connection, handlers);
    }

    // Handle incoming SRT packets
    async onClientData(readerWriter, fd, worker, connection) {
        try {
            // readChunks only resolves once it has accumulated SRT_READ_MIN_BYTES, so a
            // starved socket never returns from here. onRead fires per chunk inside its
            // loop, which is why the payload clock is driven from the callback.
            const onRead = (readBuf) => {
                const channel = this.runningChannels[fd.channel.id];
                if (channel && readBuf.byteLength > 0) {
                    channel.lastPayload = Date.now();
                }
            };
            const chunks = await readerWriter.readChunks(SRT_READ_MIN_BYTES, SRT_READ_BUF_SIZE, onRead);
            const buffer = Buffer.concat(chunks);
            worker.send({ type: 'buffer', chunks: buffer });
        } catch (error) {
            const logMeta = this.getLogMeta(fd);
            logger.error(`Error reading chunks: ${error.message}`, logMeta);
            if (error.message.includes("Connection was broken")) {
                logger.error("Connection was broken, cleaning up.", logMeta);
                this.cleanupConnection(connection, fd, worker);
            }
        }
    }

    cleanupConnection(connection, fd, worker) {
        // Reachable from the sentinel, the worker, and our own closed/error handlers,
        // sometimes for the same connection. The teardown below must happen once, but
        // the bookkeeping at the end must run on every call — stopRunningSession drains
        // runningSessions by calling us in a loop and would spin forever otherwise.
        const alreadyCleaned = connection ? this.cleanedConnections.has(connection) : false;
        if (connection) {
            this.cleanedConnections.add(connection);
        }

        if (!alreadyCleaned) {
            // Tell the streaming server controller to forward the session stop message to the broker
            this.emit('session-stop', fd.session, fd.channel.id)
            logger.info(`Connection: ${connection.fd} --> cleaning up.`, this.getLogMeta(fd));
            if (connection) {
                // Remove only our own listeners: removeAllListeners() would also strip
                // node-srt's internal 'closing' handler, which is what deletes the fd from
                // the server's _connectionMap. Nothing else ever evicts it, so stripping it
                // leaks the entry for the process lifetime.
                const handlers = this.connectionHandlers.get(connection);
                if (handlers) {
                    for (const [event, handler] of Object.entries(handlers)) {
                        connection.removeListener(event, handler);
                    }
                    this.connectionHandlers.delete(connection);
                }
                connection.close();
            }
            if (worker) {
                worker.removeAllListeners();
                worker.kill();
                const workerIndex = this.workers.indexOf(worker);
                if (workerIndex > -1) {
                    this.workers.splice(workerIndex, 1);
                }
            }
        }

        if (this.runningSessions[fd.session.id]) {
            this.runningSessions[fd.session.id] = this.runningSessions[fd.session.id].filter(item => item.fd.channel.id !== fd.channel.id);
            if (this.runningSessions[fd.session.id].length === 0) {
                delete this.runningSessions[fd.session.id];
            }
        }
        if (this.runningChannels[fd.channel.id]) {
            delete this.runningChannels[fd.channel.id]
        }
    }
}

module.exports = MultiplexedSRTServer;
