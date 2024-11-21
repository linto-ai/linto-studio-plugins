const debug = require('debug')('transcriber:StreamingServer:SRTServer');
const EventEmitter = require('eventemitter3');
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
    }

    // To verify incoming streamId and other details, controlled by streaming server forwarding from broker
    setSessions(sessions) {
        if (this.sessions) {
            // force stop running sessions
            const deletedSessions = this.sessions.filter(currentSession =>
                !sessions.some(newSession => newSession.id === currentSession.id)
            );
            const sessionsToStop = deletedSessions.filter(deletedSession =>
                this.runningSessions.hasOwnProperty(deletedSession.id)
            );
            sessionsToStop.forEach(session => this.stopRunningSession(session));
        }
        this.sessions = sessions;
    }

    async stop() {
        debug('SRT server will go DOWN !');
        this.workers.forEach(worker => {
            this.cleanupConnection(null, null, worker);
        });
        this.workers = [];
        process.exit(1);
    }

    async start() {
        try {
            this.asyncSrtServer = new SRTServer(parseInt(STREAMING_SRT_UDP_PORT), STREAMING_HOST);
            this.asyncSrtServer.on("connection", (connection) => {
                this.onConnection(connection);
            });
            this.server = await this.asyncSrtServer.create();
            // Check if STREAMING_PASSPHRASE is set and apply it along with key length
            if (STREAMING_PASSPHRASE && STREAMING_PASSPHRASE.length > 0 && STREAMING_PASSPHRASE !== 'false') {
                let keyLength = STREAMING_PASSPHRASE.length >= 32 ? 32 : (STREAMING_PASSPHRASE.length >= 24 ? 24 : 16);
                await this.server.setSocketFlags([SRT.SRTO_PASSPHRASE, SRT.SRTO_PBKEYLEN], [STREAMING_PASSPHRASE, keyLength]);
            }
            this.server.open();
            // log passphrase if set
            debug(`SRT server started on ${STREAMING_HOST}:${STREAMING_SRT_UDP_PORT} ${STREAMING_PASSPHRASE ? 'with passphrase' : ''}`);
        } catch (error) {
            debug("Error starting SRT server", error);
        }
    }

    async validateStream(connection) {
        const asyncSrt = new AsyncSRT();
        const streamId = await asyncSrt.getSockOpt(connection.fd, SRT.SRTO_STREAMID);
        debug(`Connection: ${connection.fd} --> Validating streamId ${streamId}`);

        // Extract sessionId and channelId from streamId
        const [sessionId, channelIndexStr] = streamId.split(",");
        const channelIndex = parseInt(channelIndexStr, 10);
        const session = this.sessions.find(s => s.id === sessionId);
        // Validate session
        if (!session) {
            debug(`Connection: ${connection.fd} --> session ${sessionId} not found.`);
            return { isValid: false };
        }
        // Find channel by index in array, it is recomputed at each update and ordered by id and starting at 0
        const sortedChannels = session.channels.sort((a, b) => a.id - b.id);
        const channel = sortedChannels[channelIndex];
        if (!channel) {
            debug(`Connection: ${connection.fd} --> session ${sessionId}, Channel id ${channelIndex} not found.`);
            return { isValid: false };
        }
        const channelId = channel.id;

        // Check if the channel's streamStatus is 'active'
        if (channel.streamStatus === 'active') {
            debug(`Connection: ${connection.fd} --> session ${sessionId}, Channel id ${channelId} already active. Skipping.`);
            return { isValid: false };
        }
        // Check scheduledOn is after now
        const now = new Date();
        if (session.scheduledOn && now < new Date(session.scheduledOn)) {
            debug(`Connection: ${connection.fd} --> session ${sessionId}, scheduledOn in the future. Now: ${now}, scheduledOn: ${session.scheduledOn}. Skipping.`);
            return { isValid: false };
        }
        // Check endOn is before now
        if (session.endOn && now > new Date(session.endOn)) {
            debug(`Connection: ${connection.fd} --> session ${sessionId}, endOn in the past. Now: ${now}, endOn: ${session.endOn}. Skipping.`);
            return { isValid: false };
        }

        debug(`Connection: ${connection.fd} --> session ${sessionId}, channel ${channelId} is valid. Booting worker.`);
        return { isValid: true, sessionId, channelId, session };
    }

    async onConnection(connection) {
        debug("Got new connection:", connection.fd);
        // New connection, validate stream
        const validation = await this.validateStream(connection);
        if (!validation.isValid) {
            debug(`Invalid stream: ${connection.fd}, voiding connection.`);
            // no worker to cleanup, nothing to do.
            connection = null;
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
        this.emit('session-start', fd.session, fd.channelId);
        this.addRunningSession(session, connection, fd, worker);
    }

    addRunningSession(session, connection, fd, worker) {
      if (!this.runningSessions[session.id]) {
        this.runningSessions[session.id] = [];
      }

      this.runningSessions[session.id].push({ connection, fd, worker });
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
                this.emit('data', message.buf, fd.session.id, fd.channelId);
            }
            if (message.type === 'error') {
                console.error(`Worker ${worker.pid} error --> ${message.error}`);
                this.cleanupConnection(connection, fd, worker);
            }
            if (message.type === 'playing') {
                debug(`Worker: ${worker.pid} --> transcoding session ${fd.session.id}, channel ${fd.channelId}`);
            }
        });

        worker.on('error', (err) => {
            console.log(`Worker: ${worker.pid} --> Error:`, err);
            this.cleanupConnection(connection, fd, worker);
        });

        worker.on('exit', (code, signal) => {
            debug(`Worker: ${worker.pid} --> Exited, releasing session ${fd.session.id}, channel ${fd.channelId}`);
        });
    }


    handleConnectionEvents(connection, fd, worker) {
        connection.on("data", async () => {
            if (worker && worker.connected) {
                this.onClientData(connection, fd, worker);
            }
        });

        connection.on("closing", async () => {
            debug(`Connection: ${connection.fd} --> closing`);
            connection.close()
        });

        connection.on("closed", async () => {
            debug(`Connection: ${connection.fd} --> closed`);
            if (worker && worker.connected) {
                worker.send({ type: 'terminate' });
                this.cleanupConnection(connection, fd, worker);
            }
        });

        connection.on('error', (err) => {
            console.error(`Connection: ${connection.fd} --> error:`, err);
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
            console.error(`Error reading chunks: ${error.message}`);
            if (error.message.includes("Connection was broken")) {
                debug("Connection was broken, cleaning up.");
                this.cleanupConnection(connection, fd, worker);
            }
        }
    }

    cleanupConnection(connection, fd, worker) {
        // Tell the streaming server controller to forward the session stop message to the broker
        this.emit('session-stop', fd.session, fd.channelId)
        debug(`Connection: ${connection.fd} --> cleaning up.`);
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
            this.runningSessions[fd.session.id] = this.runningSessions[fd.session.id].filter(item => item.fd.channelId !== fd.channelId);
            if (this.runningSessions[fd.session.id].length === 0) {
                delete this.runningSessions[fd.session.id];
            }
        }
    }
}

module.exports = MultiplexedSRTServer;
