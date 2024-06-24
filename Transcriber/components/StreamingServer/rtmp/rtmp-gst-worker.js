const { parentPort } = require('worker_threads');
const gstreamer = require('gstreamer-superficial');

let pipeline = null;

parentPort.on('message', async (msg) => {
    switch(msg.type) {
        case 'start':
          await start(msg.data);
          break;
        case 'stop':
          await stop();
    }
});

async function start({streamPath, port}) {
    await stop();

    let transcodePipelineString = `! flvdemux name=demux demux.audio
    ! queue
    ! aacparse
    ! avdec_aac
    ! audioconvert
    ! audioresample
    ! audio/x-raw,format=S16LE,channels=1
    ! appsink name=sink
    `

    const pipelineStr = `rtmpsrc location=rtmp://127.0.0.1:${port}${streamPath} ${transcodePipelineString}`;
    pipeline = new gstreamer.Pipeline(pipelineStr)

    let appsink = pipeline.findChild('sink');

    // Define a callback function to handle new audio samples
    const onData = (buf) => {
      parentPort.postMessage({ type: 'audio', data: buf });
    }

    const pullSamples = () => {
      appsink.pull((buf, caps) => {
        if (buf) {
          onData(buf);
          // Continue pulling samples without blocking event loop
          setImmediate(pullSamples);
        }
      });
    };

    pipeline.play();
    pullSamples();
}

async function stop() {
  if(pipeline) {
    pipeline.stop();
    pipeline = null;
  }
}
