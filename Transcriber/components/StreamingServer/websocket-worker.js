const { parentPort, workerData } = require('worker_threads');
const net = require('net');
const http = require('http');
const WebSocket = require('ws');
const { streamingHost } = workerData;
const states = {
    CLOSED: 'CLOSED',
    INITIALIZED: 'INITIALIZED',
    READY: 'READY',
    STREAMING: 'STREAMING',
    STOPPED: 'STOPPED',
    ERROR: 'ERROR'
};
let state = states.CLOSED;
let serverPort = null;
let websocketServer = null;
let httpServer = null;

function isTCPPortFree(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve(false);
      } else {
        reject(err);
      }
    });

    server.once('listening', () => {
      server.close(() => {
        resolve(true);
      });
    });

    server.listen(port, streamingHost);
  });
}

async function findFreeTCPPortInRange() {
  const [startPort, endPort] = process.env.TCP_RANGE.split('-');
  for (let port = startPort; port <= endPort; port++) {
    try {
      const isFree = await isTCPPortFree(port);
      if (isFree) {
        return port;
      }
    } catch (error) {
      throw new Error(`Error checking port ${port}: ${error.message}`);
    }
  }
  throw new Error('No free ports available in the given range.');
}


parentPort.on('message', async (msg) => {
    if (msg === 'initialize') {
        await initialize()
    }
    if (msg === 'start') {
        await start()
    }
    if (msg === 'stop') {
        await stop()
    }
});


async function initialize() {
  try {
    serverPort = await findFreeTCPPortInRange();
    httpServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('WebSocket server\n');
    });
    httpServer.listen(serverPort);
    state = states.INITIALIZED;
    parentPort.postMessage({ type: 'port_selected', data: serverPort });
  } catch (error) {
    parentPort.postMessage({ type: 'error', data: `Error when initializing transcriber: ${error}` });
  }
}


async function start(force = false) {
    // if the transcriber is not initialized, we do nothing
    if (state != states.INITIALIZED && !force) {
        parentPort.postMessage({ type: 'info', data: `Trying to start an uninitialized transcriber` });
        return
    }

    if(websocketServer) {
      websocketServer.close();
    }

    try {
      websocketServer = new WebSocket.Server({ server: httpServer });
      websocketServer.on('connection', (ws) => {

        ws.on('message', (message) => {
          if ((state === states.READY && message)) {
              state = states.STREAMING;
              parentPort.postMessage({ type: 'streaming', data: `Websocket Server streaming` });
          }
          if(message) {
            const int16Array = new Int16Array(message);
            parentPort.postMessage({ type: 'audio', data: int16Array });
          }
        });

        ws.on('close', () => {
          parentPort.postMessage({ type: 'eos', data: `End of stream reached, stopping transcriber` });
          start(true);
        });
      });
      state = states.READY;
      parentPort.postMessage({ type: 'ready', data: `SRT Server Ready to receive stream` });
    } catch (error) {
        state = states.ERROR;
        parentPort.postMessage({ type: 'error', data: `Error when starting transcriber: ${error}` });
    }
}

function stop() {
    state = states.CLOSED
    parentPort.postMessage({ type: 'closed', data: `Websocket Server closed` });
}
