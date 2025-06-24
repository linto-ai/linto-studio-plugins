const EventEmitter = require('eventemitter3');
const { logger } = require('live-srt-lib')
const { SRT, SRTServer, AsyncSRT } = require("linto-node-srt");
const { fork } = require('child_process');
const path = require('path');

const {
    STREAMING_PASSPHRASE,
    STREAMING_HOST,
    STREAMING_SRT_UDP_PORT,
} = process.env;

class MultiplexedSRTServer extends EventEmitter {
    constructor(app) {
        super();
        this.app = app;
        this.workers = []; // Workers for SRT connections (gstreamer)
        this.asyncSrtServer = null;
        this.runningSessions = {}
        this.runningChannels = {}
        this.channelTimeoutSeconds = 5;

        setInterval(() => {
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
                logger.debug(`Force cut the stream of sessions: ${sessionsToStop.map(s => s.id).join(", ")}`);
            }
            sessionsToStop.forEach(session => this.stopRunningSession(session));
        }
    }

    checkTimedOutChannel() {
        const now = Date.now();
        for (const value of Object.values(this.runningChannels)) {
            if (now - value.lastPacket > this.channelTimeoutSeconds * 1000) {
                logger.warn(`Channel ${value.fd.channel.id} timeout, closing !`);
                this.cleanupConnection(value.connection, value.fd, value.worker);
            }
        }
    }

    async start() {
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
            // log passphrase if set
            logger.debug(`SRT server started on ${STREAMING_HOST}:${STREAMING_SRT_UDP_PORT} ${hasPassphrase ? 'with passphrase' : ''}`);
        } catch (error) {
            logger.debug("Error starting SRT server", error);
        }
    }

    async validateStream(connection) {
        const asyncSrt = new AsyncSRT();
        const streamId = await asyncSrt.getSockOpt(connection.fd, SRT.SRTO_STREAMID);
        logger.debug(`Connection: ${connection.fd} --> Validating streamId ${streamId}`);

        // Extract sessionId and channelId from streamId
        const [sessionId, channelIndexStr] = streamId.split(",");
        const channelIndex = parseInt(channelIndexStr, 10);
        const session = this.sessions.find(s => s.id === sessionId);
        // Validate session
        if (!session) {
            logger.debug(`Connection: ${connection.fd} --> session ${sessionId} not found.`);
            return { isValid: false };
        }
        // Find channel by index in array, it is recomputed at each update and ordered by id and starting at 0
        const sortedChannels = session.channels.sort((a, b) => a.id - b.id);
        const channel = sortedChannels[channelIndex];
        if (!channel) {
            logger.debug(`Connection: ${connection.fd} --> session ${sessionId}, Channel id ${channelIndex} not found.`);
            return { isValid: false };
        }
        const channelId = channel.id;

        // Check if the channel's streamStatus is 'active'
        if (channel.streamStatus === 'active') {
            logger.debug(`Connection: ${connection.fd} --> session ${sessionId}, Channel id ${channelId} already active. Skipping.`);
            return { isValid: false };
        }
        // Check scheduleOn is after now
        const now = new Date();
        if (session.autoStart && session.scheduleOn && now < new Date(session.scheduleOn)) {
            logger.debug(`Connection: ${connection.fd} --> session ${sessionId}, scheduleOn in the future. Now: ${now}, scheduleOn: ${session.scheduleOn}. Skipping.`);
            return { isValid: false };
        }
        // Check endOn is before now
        if (session.autoEnd && session.endOn && now > new Date(session.endOn)) {
            logger.debug(`Connection: ${connection.fd} --> session ${sessionId}, endOn in the past. Now: ${now}, endOn: ${session.endOn}. Skipping.`);
            return { isValid: false };
        }

        logger.debug(`Connection: ${connection.fd} --> session ${sessionId}, channel ${channelId} is valid. Booting worker.`);
        return { isValid: true, session, channel };
    }

    async onConnection(connection) {
        logger.debug("Got new connection:", connection.fd);
        // New connection, validate stream
        const validation = await this.validateStream(connection);
        if (!validation.isValid) {
            logger.debug(`Invalid stream: ${connection.fd}, voiding connection.`);
            // no worker to cleanup, nothing to do.
            connection.close();
            connection = null;
            return;
        }
        // Stream is valid, store connection file descriptor
        const { channel, session } = validation;
        // Create a new file descriptor object to store connection details and session info
        const fd = {
            channel,
            session
        };
        // Start a new worker for this connection
        const worker = fork(path.join(__dirname, '../GstreamerWorker.js'), [], {
        });
        this.workers.push(worker);
        // Start gstreamer pipeline
        worker.send({ type: 'init' });
        // handle events
        this.handleWorkerEvents(connection, fd, worker);
        this.handleConnectionEvents(connection, fd, worker);
        // Acknowledge session for streaming server controller to handle further processing
        // - call scheduler to update session status to active
        // - start buffering audio in circular buffer
        // - start transcription
        this.emit('session-start', fd.session, fd.channel);
        this.addRunningSession(session, connection, fd, worker);
    }

    addRunningSession(session, connection, fd, worker) {
      if (!this.runningSessions[session.id]) {
        this.runningSessions[session.id] = [];
      }

      this.runningSessions[session.id].push({ connection, fd, worker });

      this.runningChannels[fd.channel.id] = { connection, fd, worker, lastPacket: Date.now()};
    }

    stopRunningSession(session) {
      while (this.runningSessions[session.id] && this.runningSessions[session.id].length > 0) {
        const { connection, fd, worker } = this.runningSessions[session.id][0];
        this.cleanupConnection(connection, fd, worker);
      }
    }

    // Events sent by the worker
    handleWorkerEvents(connection, fd, worker) {
        worker.on('message', async (message) => {
            if (message.type === 'data') {
                this.emit('data', message.buf, fd.session.id, fd.channel.id);
            }
            if (message.type === 'error') {
                logger.error(`Worker ${worker.pid} error --> ${message.error}`);
                this.cleanupConnection(connection, fd, worker);
            }
            if (message.type === 'playing') {
                logger.debug(`Worker: ${worker.pid} --> transcoding session ${fd.session.id}, channel ${fd.channel.id}`);
            }
        });

        worker.on('error', (err) => {
            logger.error(`Worker: ${worker.pid} --> Error:`, err);
            this.cleanupConnection(connection, fd, worker);
        });

        worker.on('exit', (code, signal) => {
            logger.debug(`Worker: ${worker.pid} --> Exited, releasing session ${fd.session.id}, channel ${fd.channel.id}`);
        });
    }


    handleConnectionEvents(connection, fd, worker) {
        connection.on("data", async () => {
            if (worker && worker.connected) {
                this.onClientData(connection, fd, worker);
            }
            if (this.runningChannels[fd.channel.id]) {
                this.runningChannels[fd.channel.id].lastPacket = Date.now();
            }
        });

        connection.on("closing", async () => {
            logger.debug(`Connection: ${connection.fd} --> closing`);
            connection.close()
        });

        connection.on("closed", async () => {
            logger.debug(`Connection: ${connection.fd} --> closed`);
            if (worker && worker.connected) {
                worker.send({ type: 'terminate' });
            }
            this.cleanupConnection(connection, fd, worker);
        });

        connection.on('error', (err) => {
            logger.error(`Connection: ${connection.fd} --> error:`, err);
            this.cleanupConnection(connection, fd, worker);
        });
    }

    // Handle incoming SRT packets
    async onClientData(connection, fd, worker) {
        try {
            const chunks = await connection.getReaderWriter().readChunks();
            const serializedChunks = chunks.map(chunk => Array.from(chunk));
            worker.send({ type: 'data', chunks: serializedChunks });
        } catch (error) {
            logger.error(`Error reading chunks: ${error.message}`);
            if (error.message.includes("Connection was broken")) {
                logger.debug("Connection was broken, cleaning up.");
                this.cleanupConnection(connection, fd, worker);
            }
        }
    }

    cleanupConnection(connection, fd, worker) {
        // Tell the streaming server controller to forward the session stop message to the broker
        this.emit('session-stop', fd.session, fd.channel.id)
        logger.debug(`Connection: ${connection.fd} --> cleaning up.`);
        if (connection) {
            connection.close();
            connection = null;
        }
        if (worker) {
            worker.kill();
            const workerIndex = this.workers.indexOf(worker);
            if (workerIndex > -1) {
                this.workers.splice(workerIndex, 1);
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
