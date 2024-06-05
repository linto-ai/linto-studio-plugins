const net = require('net');
const { Worker, parentPort } = require('worker_threads');
const NodeMediaServer = require('node-media-server');
const path = require('path');
const states = {
    CLOSED: 'CLOSED',
    INITIALIZED: 'INITIALIZED',
    READY: 'READY',
    STREAMING: 'STREAMING',
    STOPPED: 'STOPPED',
    ERROR: 'ERROR'
};
let state = states.CLOSED;
let rtmpPort = null;
let nms = null;
let worker = null;


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

    server.listen(port, '0.0.0.0');
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
    rtmpPort = await findFreeTCPPortInRange()
    try {
        const config = {
          rtmp: {
            port: rtmpPort,
            chunk_size: 60000,
            gop_cache: true,
            ping: 30,
            ping_timeout: 60
          }
        }
        nms = new NodeMediaServer(config);
        nms.run();
        nms.on('postPublish', (id, streamPath, args) => {

          if (!worker) {
            return;
          }

          worker.postMessage({type: 'start', data: {streamPath, rtmpPort}});

          worker.on('message', (msg) => {
            switch(msg.type) {
                case 'audio':
                    const buf = msg.data;
                    if ((state === states.READY && buf)) {
                        state = states.STREAMING;
                        parentPort.postMessage({ type: 'streaming', data: `SRT Server streaming` });
                    }
                    if (buf) {
                        parentPort.postMessage({ type: 'audio', data: buf });
                    }
                    break;
            }
          });

          worker.on('error', (err) => {
            state = states.ERROR;
            parentPort.postMessage({ type: 'error', data: `Error when starting transcriber: ${error}` });
          });
        });

        nms.on('donePublish', (id, streamPath, args) => {
          // huge latence
          // if start is called to soon, the transcriber state will be READY
          // but the remaining data will put the state as STREAMING...
          // we can't stop and start nms server because stop is async and we can't now when it will be stopped
          // so we would need a setTimeout in all cases.
          setTimeout(() => {
            parentPort.postMessage({ type: 'eos', data: `End of stream reached, stopping transcriber` });
            start(true);
          }, 3000);
        });

        state = states.INITIALIZED;
        parentPort.postMessage({ type: 'port_selected', data: rtmpPort });
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

    if(worker) {
      worker.postMessage({type: 'stop', data: 'Stopping worker'});
    }
    else {
        worker = new Worker(path.join(__dirname, 'rtmp-gst-worker.js'));
    }

    state = states.READY;
    parentPort.postMessage({ type: 'ready', data: `RTMP Server Ready to receive stream` });
}

async function stop() {
    if(worker) {
      worker.postMessage({type: 'stop', data: 'Stopping worker'});
    }
    nms.stop();
    state = states.CLOSED
    parentPort.postMessage({ type: 'closed', data: `RTMP Server closed` });
}
