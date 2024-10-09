const debug = require('debug')('transcriber:StreamingServer:WebsocketServer');
const { fork } = require('child_process');
const EventEmitter = require('eventemitter3');
const { CustomErrors } = require("live-srt-lib");
const path = require('path');
const url = require('url');
const WebSocket = require('ws');

const {
    STREAMING_HOST,
    STREAMING_WS_TCP_PORT
} = process.env;

class MultiplexedWebsocketServer extends EventEmitter {
  constructor(app) {
    super();
    this.app = app;
    this.wss = null;
    this.workers = [];
  }

  setSessions(sessions) {
      this.sessions = sessions;
  }

  async stop() {
      debug('Websocket server will go DOWN !');
      this.workers.forEach(worker => {
          this.cleanupConnection(null, null, worker);
      });
      this.workers = [];
      process.exit(1);
  }


  async start() {
      try {
          this.wss = new WebSocket.Server({ port: parseInt(STREAMING_WS_TCP_PORT), host: STREAMING_HOST});
          this.wss.on("connection", (ws, req) => {
              this.onConnection(ws, req);
          });
          debug(`WS server started on ${STREAMING_HOST}:${STREAMING_WS_TCP_PORT}`);
      } catch (error) {
          debug("Error starting WS server", error);
      }
  }

  async validateStream(req) {
    const streamId = req.url.substring(1)
    debug(`Connection: ${req.url} --> Validating streamId ${streamId}`);

      // Extract sessionId and channelId from streamId
      const [sessionId, channelIdStr] = streamId.split(",");
      const channelId = parseInt(channelIdStr, 10);
      const session = this.sessions.find(s => s.id === sessionId);
      // Validate session
      if (!session) {
          debug(`Connection: ${req.url} --> session ${sessionId} not found.`);
          return { isValid: false };
      }
      // Find channel by "id" key (do not rely on position in array that changes upon updates)
      const channel = session.channels.find(c => c.id === channelId);
      if (!channel) {
          debug(`Connection: ${req.url} --> session ${sessionId}, Channel id ${channelId} not found.`);
          return { isValid: false };
      }
      // Check if the channel's streamStatus is 'active'
      if (channel.streamStatus === 'active') {
          debug(`Connection: ${req.url} --> session ${sessionId}, Channel id ${channelId} already active. Skipping.`);
          return { isValid: false };
      }
      // Check startTime is after now
      const now = new Date();
      if (session.startTime && now < new Date(session.startTime)) {
          debug(`Connection: ${req.url} --> session ${sessionId}, startTime in the future. Now: ${now}, startTime: ${session.startTime}. Skipping.`);
          return { isValid: false };
      }
      // Check endTime is before now
      if (session.endTime && now > new Date(session.endTime)) {
          debug(`Connection: ${req.url} --> session ${sessionId}, endTime in the past. Now: ${now}, endTime: ${session.startTime}. Skipping.`);
          return { isValid: false };
      }

      debug(`Connection: ${req.url} --> session ${sessionId}, channel ${channelId} is valid. Booting worker.`);
      return { isValid: true, sessionId, channelId, session };
  }

  async onConnection(ws, req) {
      debug("Got new connection:", req.url);
      // New connection, validate stream
      const validation = await this.validateStream(req);
      if (!validation.isValid) {
          debug(`Invalid stream: ${req.url}, voiding connection.`);
          this.cleanupWebsocket(ws, null, null);
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
      this.handleWebsocketEvents(ws, fd, worker);
      this.handleWorkerEvents(ws, fd, worker);
      // Acknowledge session for streaming server controller to handle further processing
      // - call scheduler to update session status to active
      // - start buffering audio in circular buffer
      // - start transcription
      this.emit('session-start', fd.session, fd.channelId);
  }

  // Events sent by the worker
  handleWorkerEvents(ws, fd, worker) {
      worker.on('message', async (message) => {
          if (message.type === 'data') {
              this.emit('data', message.buf, fd.session.id, fd.channelId);
          }
          if (message.type === 'error') {
              console.error(`Worker ${worker.pid} error --> ${message.error}`);
              this.cleanupWebsocket(ws, fd, worker);
          }
          if (message.type === 'playing') {
              debug(`Worker: ${worker.pid} --> transcoding session ${fd.session.id}, channel ${fd.channelId}`);
          }
      });

      worker.on('error', (err) => {
          console.log(`Worker: ${worker.pid} --> Error:`, err);
          this.cleanupWebsocket(ws, fd, worker);
      });

      worker.on('exit', (code, signal) => {
          debug(`Worker: ${worker.pid} --> Exited, releasing session ${fd.session.id}, channel ${fd.channelId}`);
      });
  }

  handleWebsocketEvents(ws, fd, worker) {
      ws.on("message", (message) => {
          this.onClientData(message, worker);
      });

      ws.on("close", () => {
          debug(`Connection: ${ws} --> closed`);
          worker.send({ type: 'terminate' });
          this.cleanupWebsocket(ws, fd, worker);
      });
  }

  onClientData(message, worker) {
      worker.send({ type: 'buffer', chunks: Buffer.from(new Int16Array(message))});
  }

  cleanupWebsocket(ws, fd, worker) {
      // Tell the streaming server controller to forward the session stop message to the broker
      if (fd) {
        this.emit('session-stop', fd.session, fd.channelId)
      }

      debug(`Connection: ${ws} --> cleaning up.`);
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
  }
}


module.exports = MultiplexedWebsocketServer;
