const dgram = require('dgram');
const gstreamer = require('gstreamer-superficial');
const { mode, streamingHost, passphrase, srtPort } = process.env;
let ERROR_COUNT = 0;
const MAX_ERROR_COUNT = 10;
let currentSRTPort = null;
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
    if (msg.type === 'stop_pipeline') {
        await stopPipeline();
    }
});


// Locks a UDP port for the SRT server within range with a fakesink pipeline
async function initialize() {
    try {
        if (pipeline) {
            process.send({ type: 'info', data: `Trying to initialize a SRT server whereas a pipeline already exist` });
            stopPipeline();
        }
        currentSRTPort = srtPort ? srtPort : await findFreeUDPPortInRange();
        let internalStreamURI = `srt://${streamingHost}:${currentSRTPort}?mode=${mode}`;
        if (passphrase) {
            internalStreamURI += `&passphrase=${passphrase}`;
        }
        const pipelineString = `srtsrc uri="${internalStreamURI}" ! fakesink`;
        pipeline = new gstreamer.Pipeline(pipelineString)
        pipeline.pollBus(async (msg) => {
            switch (msg.type) {
                case 'error':
                    if (ERROR_COUNT > MAX_ERROR_COUNT) {
                        process.send({ type: 'error', data: "Too many errors when trying to start GStreamer pipeline" });
                    }
                    ERROR_COUNT++;
                    process.send({ type: 'reinit', data: `Error when trying to create GStreamer streaming server: Pipeline: ${pipelineString} | ${JSON.stringify(msg)}, retrying...` });
                    stopPipeline();
                    break;
                default:
                    break;
            }
        });
        await pipeline.play();
        process.send({ type: 'port_selected', data: currentSRTPort });
    } catch (error) {
        process.send({ type: 'error', data: `Error when initializing transcriber: ${error}` });
    }
}


async function start() {
    if (!srtPort) {
        process.send({ type: 'error', data: `Can't start srt server without port` });
        return
    }
    currentSRTPort = srtPort

    if (pipeline) {
        process.send({ type: 'info', data: `Trying to initialize a SRT server whereas a pipeline already exist` });
        return;
    }

    let transcodePipelineString = `
    ! queue
    ! decodebin3 caps="audio/x-raw"
    ! queue
    ! audioconvert
    ! audio/x-raw,format=S16LE,channels=1
    ! queue
    ! audioresample
    ! audio/x-raw,rate=16000
    ! queue
    ! appsink name=sink
    `
    try {
        let internalStreamURI = `srt://${streamingHost}:${currentSRTPort}?mode=${mode}`;
        if (passphrase) {
            internalStreamURI += `&passphrase=${passphrase}`;
        }
        const pipelineString = `srtsrc uri="${internalStreamURI}" ${transcodePipelineString}`;
        pipeline = new gstreamer.Pipeline(pipelineString);

        pipeline.pollBus(async (msg) => {
            switch (msg.type) {
                case 'eos':
                    stopPipeline();
                    process.send({ type: 'eos', data: `End of stream reached, stopping transcriber` });
                    return
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
            if (buf) {
                process.send({ type: 'audio', data: buf });
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
        process.send({ type: 'ready', data: `SRT Server Ready to receive stream` });
        pullSamples();
    } catch (error) {
        process.send({ type: 'error', data: `Error when starting transcriber: ${error}` });
    }

}

function stopPipeline() {
    if (appsink) {
        appsink = null;
    }
    if (pipeline) {
        pipeline.stop();
        pipeline = null;
    }
}

async function stop() {
    stopPipeline();
    process.send({ type: 'closed', data: `SRT Server closed` });
}
