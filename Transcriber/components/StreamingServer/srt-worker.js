const { parentPort, workerData } = require('worker_threads');
const dgram = require('dgram');
const gstreamer = require('gstreamer-superficial');
const { mode, streamingHost, passphrase } = workerData;
const states = {
    CLOSED: 'CLOSED',
    INITIALIZED: 'INITIALIZED',
    READY: 'READY',
    STREAMING: 'STREAMING',
    STOPPED: 'STOPPED',
    ERROR: 'ERROR'
};
let state = states.CLOSED;
let ERROR_COUNT = 0;
const MAX_ERROR_COUNT = 10;
let srtPort = null;
let pipeline = null;
let appsink = null;

async function findFreeUDPPortInRange() {
    const [startPort, endPort] = process.env.UDP_RANGE.split('-');
    for (let port = startPort; port <= endPort; port++) {
        if (!(await isUDPPortInUse(port))) {
            return port;
        }
    }
    throw new Error(`No available UDP port found in range ${startPort}-${endPort}`);
}

function isUDPPortInUse(port) {
    return new Promise((resolve, reject) => {
        const socket = dgram.createSocket('udp4');
        setTimeout(() => {
            socket.bind(port, () => {
                socket.once('close', () => {
                    resolve(false);
                });
                socket.close();
            });
        }, Math.floor(Math.random() * 4500) + 500); // Wait for a random time between 500 and 5000 milliseconds
        socket.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                resolve(true);
            } else {
                reject(err);
            }
        });
    });
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


// Locks a UDP port for the SRT server within range with a fakesink pipeline
async function initialize() {
    try {
        if (pipeline) { pipeline.stop() }
        srtPort = await findFreeUDPPortInRange();
        let internalStreamURI = `srt://${streamingHost}:${srtPort}?mode=${mode}`;
        if (passphrase) {
            internalStreamURI += `&passphrase=${passphrase}`;
        }
        const pipelineString = `srtsrc uri="${internalStreamURI}" ! fakesink`;
        pipeline = new gstreamer.Pipeline(pipelineString)
        pipeline.pollBus(async (msg) => {
            switch (msg.type) {
                case 'error':
                    state = states.ERROR;
                    if (ERROR_COUNT > MAX_ERROR_COUNT) {
                        parentPort.postMessage({ type: 'error', data: "Too many errors when trying to start GStreamer pipeline" });
                    }
                    ERROR_COUNT++;
                    parentPort.postMessage({ type: 'reinit', data: `Error when trying to create GStreamer streaming server, retrying...` });
                    stop();
                    break;
                default:
                    break;
            }
        });
        await pipeline.play();
        state = states.INITIALIZED;
        parentPort.postMessage({ type: 'port_selected', data: srtPort });
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

    // shutdown dummy pipeline if it is running
    if (pipeline) {
        stop()
    }

    let transcodePipelineString = `! queue
    ! decodebin
    ! queue
    ! audioconvert
    ! audio/x-raw,format=S16LE,channels=1
    ! queue
    ! audioresample
    ! audio/x-raw,rate=16000
    ! queue
    ! appsink name=sink`
    try {
        let internalStreamURI = `srt://${streamingHost}:${srtPort}?mode=${mode}`;
        if (passphrase) {
            internalStreamURI += `&passphrase=${passphrase}`;
        }
        const pipelineString = `srtsrc uri="${internalStreamURI}" ${transcodePipelineString}`;
        pipeline = new gstreamer.Pipeline(pipelineString);

        pipeline.pollBus(async (msg) => {
            switch (msg.type) {
                case 'eos':
                    parentPort.postMessage({ type: 'eos', data: `End of stream reached, stopping transcriber` });
                    // restart the pipeline
                    start(true)
                    break;
                case 'state-changed':
                    if (msg._src_element_name === 'sink') {
                        // Here we might do something when the appsink state changes
                        //debug(`Sink state changed from ${msg['old-state']} to ${msg['new-state']}`);
                    }
                    break;
                default:
                    break;
            }
        });

        // Find the appsink element in the pipeline
        appsink = pipeline.findChild('sink');

        // Define a callback function to handle new audio samples
        const onData = (buf, caps) => {
            if ((state === states.READY && buf)) {
                state = states.STREAMING;
                parentPort.postMessage({ type: 'streaming', data: `SRT Server streaming` });
            }
            if (buf) {
                parentPort.postMessage({ type: 'audio', data: buf });
            }
        }

        const pullSamples = () => {
          appsink.pull((buf, caps) => {
            if (buf) {
              onData(buf, caps);
              // Continue pulling samples without blocking event loop
              setImmediate(pullSamples);
            }
          });
        };

        await pipeline.play()
        state = states.READY;
        parentPort.postMessage({ type: 'ready', data: `SRT Server Ready to receive stream` });
        pullSamples();
    } catch (error) {
        state = states.ERROR;
        parentPort.postMessage({ type: 'error', data: `Error when starting transcriber: ${error}` });
    }

}

async function stop() {
    if (pipeline) {
        pipeline.stop();
        pipeline = null;
    }
    if (appsink) {
        appsink = null;
    }
    state = states.CLOSED
    parentPort.postMessage({ type: 'closed', data: `SRT Server closed` });
}
