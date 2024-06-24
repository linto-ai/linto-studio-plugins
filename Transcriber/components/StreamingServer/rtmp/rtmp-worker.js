const net = require('net');
const { Worker } = require('worker_threads');
const { rtmpPort } = process.env;
const NodeMediaServer = require('node-media-server');
const path = require('path');
let currentRtmpPort = null;
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

process.on('message', async (msg) => {
    if (msg.type === 'initialize') {
        await initialize()
    }
    if (msg.type === 'start') {
        await start()
    }
    if (msg.type === 'stop') {
        await stop()
    }
});


function runNMS(port) {
    const config = {
      rtmp: {
        port: port,
        chunk_size: 60000,
        gop_cache: true,
        ping: 30,
        ping_timeout: 60
      }
    }
    nms = new NodeMediaServer(config);
    nms.run();
}

function listenNMS(port) {
    nms.on('postPublish', (id, streamPath, args) => {

      if (!worker) {
        process.send({ type: 'info', data: `Can't start gstreamer if worker is null` });
        return;
      }

      worker.postMessage({type: 'start', data: {streamPath, port}});

      worker.on('message', (msg) => {
        switch(msg.type) {
            case 'audio':
                const buf = msg.data;
                process.send({ type: 'audio', data: Buffer.from(buf) });
                break;
            case 'info':
                process.send({ type: 'info', data: msg.data });
                break;
        }
      });

      worker.on('error', (err) => {
        process.send({ type: 'error', data: `Error when starting transcriber: ${error}` });
      });
    });

    nms.on('donePublish', (id, streamPath, args) => {
      // huge latence
      // if start is called to soon, the transcriber state will be READY
      // but the remaining data will put the state as STREAMING...
      // we can't stop and start nms server because stop is async and we can't now when it will be stopped
      // so we would need a setTimeout in all cases.
      setTimeout(() => {
        process.send({ type: 'eos', data: `End of stream reached, stopping transcriber` });
      }, 3000);
    });
}

async function initialize() {
    currentRtmpPort = rtmpPort ? rtmpPort: await findFreeTCPPortInRange();
    try {
        runNMS(currentRtmpPort);
        process.send({ type: 'port_selected', data: currentRtmpPort });
    } catch (error) {
        process.send({ type: 'error', data: `Error when initializing transcriber: ${error}` });
    }
}


async function start() {
    if (!rtmpPort) {
        process.send({ type: 'error', data: `Can't start rtmp server without port` });
        return
    }
    currentRtmpPort = rtmpPort;
    runNMS(currentRtmpPort);
    worker = new Worker(path.join(__dirname, 'rtmp-gst-worker.js'));
    listenNMS(currentRtmpPort);


    process.send({ type: 'ready', data: `RTMP Server Ready to receive stream` });
}

async function stop() {
    if(worker) {
      worker.postMessage({type: 'stop', data: 'Stopping worker'});
    }
    nms.stop();
    process.send({ type: 'closed', data: `RTMP Server closed` });
}
