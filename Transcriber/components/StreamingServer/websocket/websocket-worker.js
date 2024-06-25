const net = require('net');
const http = require('http');
const WebSocket = require('ws');
const { streamingHost, websocketPort } = process.env;
let currentWebsocketPort = null;
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


process.on('message', async (msg) => {
    if (msg.type === 'initialize') {
        await initialize();
    }
    if (msg.type === 'start') {
        await start();
    }
    if (msg.type === 'stop') {
        await stop();
    }
});

function runHTTPServer(port) {
    httpServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('WebSocket server\n');
    });
    httpServer.listen(port);
}

async function initialize() {
  try {
    currentWebsocketPort = websocketPort ? websocketPort: await findFreeTCPPortInRange();
    runHTTPServer(currentWebsocketPort);
    process.send({ type: 'port_selected', data: currentWebsocketPort });
  } catch (error) {
    process.send({ type: 'error', data: `Error when initializing transcriber: ${error}` });
  }
}


async function start() {
    if (!websocketPort) {
        process.send({ type: 'error', data: `Can't start websocket server without port` });
        return
    }
    currentWebsocketPort = websocketPort;

    runHTTPServer(currentWebsocketPort);

    try {
      websocketServer = new WebSocket.Server({ server: httpServer });
      websocketServer.on('connection', (ws) => {

        ws.on('message', (message) => {
          if(message) {
            const int16Array = new Int16Array(message);
            process.send({ type: 'audio', data: Buffer.from(int16Array) });
          }
        });

        ws.on('close', () => {
          process.send({ type: 'eos', data: `End of stream reached, stopping transcriber` });
        });
      });
      process.send({ type: 'ready', data: `SRT Server Ready to receive stream` });
    } catch (error) {
        process.send({ type: 'error', data: `Error when starting transcriber: ${error}` });
    }
}

function stop() {
    if(websocketServer) {
      websocketServer.close();
      websocketServer = null;
    }
    if(httpServer) {
      httpServer.close();
      httpServer = null;
    }

    process.send({ type: 'closed', data: `Websocket Server closed` });
}
