const gstreamer = require('gstreamer-superficial');

let pipeline = null;

process.on('message', async (msg) => {
    switch(msg.type) {
        case 'init':
          await init(msg.streamPath);
          break;
        case 'terminate':
          if(pipeline) {
            pipeline.stop();
            pipeline = null;
          }
          break;
    }
});

async function init(streamPath) {
    let transcodePipelineString = `! flvdemux name=demux demux.audio
    ! queue
    ! aacparse
    ! avdec_aac
    ! audioconvert
    ! audioresample
    ! audio/x-raw,format=S16LE,channels=1
    ! appsink name=sink
    `
    const pipelineStr = `rtmpsrc location=rtmp://127.0.0.1:${process.env.STREAMING_RTMP_TCP_PORT}${streamPath} ${transcodePipelineString}`;
    try {
      pipeline = new gstreamer.Pipeline(pipelineStr)
    } catch (error) {
      process.send({ type: 'error', error: `Pipeline initialization error: ${error.message}` });
      process.exit(0);
    }

    const appsink = pipeline.findChild('sink');

    // Define a callback function to handle new audio samples
    const onData = (buf) => {
      process.send({ type: 'data', buf: Buffer.from(buf) });
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
