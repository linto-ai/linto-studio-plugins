const gstreamer = require("gstreamer-superficial");
const { logger } = require('live-srt-lib')

let pipeline;

// Sent from SRTServer.js SRT packets from client
process.on('message', (message) => {
    if (message.type === 'init') {
        initializeWorker(message.streamPath);
    } else if (message.type === 'data') {
        const chunks = message.chunks.map(chunk => Buffer.from(new Uint8Array(chunk)));
        sendDataToPipeline(chunks);
    } else if (message.type === 'buffer') {
        const buffer = Buffer.from(message.chunks);
        sendDataToPipeline([buffer]);
    } else if (message.type === 'terminate') {
        if (pipeline) {
            try {
                pipeline.stop();
                pipeline = null;
            } catch (error) {
                logger.error('Error stopping pipeline:', error);
            }
            process.exit(0);
        }
    }
});

function sendDataToPipeline(dataArray) {
    const appsrc = pipeline.findChild("mysource");
    if (appsrc) {
        dataArray.forEach(data => {
            const bufferData = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
            appsrc.push(bufferData);
        });
    } else {
        logger.error("Could not find appsrc in pipeline");
        process.exit(0);
    }
}

function getGenericPipeline() {
    return `appsrc name=mysource is-live=false format=bytes do-timestamp=true
    ! queue
    ! decodebin
    ! queue
    ! audioconvert
    ! audio/x-raw,format=S16LE,channels=1
    ! queue
    ! audioresample
    ! audio/x-raw,rate=16000
    ! queue
    ! appsink name=sink sync=false drop=false`;
}

function getRTMPPipeline(streamPath) {
    let transcodePipelineString = `! flvdemux name=demux demux.audio
    ! queue
    ! aacparse
    ! avdec_aac
    ! audioconvert
    ! audioresample
    ! audio/x-raw,format=S16LE,channels=1
    ! appsink name=sink sync=false drop=false
    `;
    return `rtmpsrc location=rtmp://127.0.0.1:${process.env.STREAMING_RTMP_TCP_PORT}${streamPath} ${transcodePipelineString}`;
}

function initializeWorker(streamPath) {
    const transcodePipelineString = streamPath ? getRTMPPipeline(streamPath) : getGenericPipeline();

    try {
        pipeline = new gstreamer.Pipeline(transcodePipelineString); // Initialize pipeline
    } catch (error) {
        process.send({ type: 'error', error: `Pipeline initialization error: ${error.message}` });
        process.exit(0);
    }

    const appsink = pipeline.findChild('sink');
    pipeline.pollBus(async (msg) => {
        switch (msg.type) {
            case 'eos':
                process.send({ type: 'eos' });
                process.exit(0);
            case 'state-changed':
                if (msg._src_element_name === 'sink') {
                    if (msg['new-state'] === 'GST_STATE_PLAYING') {
                        process.send({ type: 'playing' });
                    }
                }
                break;
            case 'error':
                process.send({ type: 'error', error: `GStreamer error: ${msg.message}` });
                process.exit(0);
            default:
                break;
        }
    });

    // Send RAW audio data to the parent process (serialized Uint8Array chunks)
    const onData = (buf, caps) => {
        if (buf) {
            process.send({ type: 'data', buf: buf });
        }
    };

    const pullSamples = () => {
        appsink.pull((buf, caps) => {
            if (buf) {
                onData(buf, caps);
                setImmediate(pullSamples);
            }
        });
    };

    (async () => {
        try {
            await pipeline.play();
            pullSamples();
        } catch (error) {
            process.send({ type: 'error', error: `Error starting the pipeline: ${error.message}` });
        }
    })();
}
