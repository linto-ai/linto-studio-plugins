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

      // Extract sessionId and channelIndex from streamId
      const [sessionId, channelIndexStr] = streamId.split(",");
      const channelIndex = parseInt(channelIndexStr, 10);
      const session = this.sessions.find(s => s.id === sessionId);
      // Validate session
      if (!session) {
          debug(`Connection: ${req.url} --> session ${sessionId} not found.`);
          return { isValid: false };
      }
      // Find channel by "index" key (do not rely on position in array that changes upon updates)
      const channel = session.channels.find(c => c.index === channelIndex);
      if (!channel) {
          debug(`Connection: ${req.url} --> session ${sessionId}, Channel index ${channelIndex} not found.`);
          return { isValid: false };
      }
      // Check if the channel's stream_status is 'active'
      if (channel.stream_status === 'active') {
          debug(`Connection: ${req.url} --> session ${sessionId}, Channel index ${channelIndex} already active. Skipping.`);
          return { isValid: false };
      }
      debug(`Connection: ${req.url} --> session ${sessionId}, channel ${channelIndex} is valid. Booting worker.`);
      return { isValid: true, sessionId, channelIndex, session };
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
      const { channelIndex, session } = validation;
      // Create a new file descriptor object to store connection details and session info
      const fd = {
          channelIndex,
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
      this.emit('session-start', fd.session, fd.channelIndex);
  }

  // Events sent by the worker
  handleWorkerEvents(ws, fd, worker) {
      worker.on('message', async (message) => {
          if (message.type === 'data') {
              this.emit('data', message.buf, fd.session.id, fd.channelIndex);
          }
          if (message.type === 'error') {
              console.error(`Worker ${worker.pid} error --> ${message.error}`);
              this.cleanupWebsocket(ws, fd, worker);
          }
          if (message.type === 'playing') {
              debug(`Worker: ${worker.pid} --> transcoding session ${fd.session.id}, channel ${fd.channelIndex}`);
          }
      });

      worker.on('error', (err) => {
          console.log(`Worker: ${worker.pid} --> Error:`, err);
          this.cleanupWebsocket(ws, fd, worker);
      });

      worker.on('exit', (code, signal) => {
          debug(`Worker: ${worker.pid} --> Exited, releasing session ${fd.session.id}, channel ${fd.channelIndex}`);
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
        this.emit('session-stop', fd.session, fd.channelIndex)
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
