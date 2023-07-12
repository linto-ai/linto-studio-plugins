const debug = require('debug')(`transcriber:ASR:StreamServerEvents`);
const { CircularBuffer } = require("live-srt-lib");

//here, "this" is bound to the ASR component
module.exports = async function () {
    const { READY, TRANSCRIBING } = this.constructor.states;
    const circularAudioBuffer = new CircularBuffer();
    this.app.components['StreamingServer'].on('streaming', () => {
        if ((this.state === this.constructor.states.TRANSCRIBING)) return;
        this.startTranscription();
    });

    this.app.components['StreamingServer'].on('audio', (streamedAudio) => {
        circularAudioBuffer.add(streamedAudio);
        // ASR not ready or not already transcribing ? RETURN
        // circularAudiobuffer will accumulate audio until MAX_AUDIO_BUFFER is reached, after which it will start overwriting the oldest audio
        // circularAudiobuffer is transcribed and flushed when it reaches MIN_AUDIO_BUFFER duration in milliseconds
        if (!(this.state === READY || this.state === TRANSCRIBING)) return;
        const audioBuffer = circularAudioBuffer.getAudioBuffer();
        if (audioBuffer.length >= Math.floor(process.env.MIN_AUDIO_BUFFER/1000 * process.env.SAMPLE_RATE * process.env.BYTES_PER_SAMPLE)) {
          this.transcribe(audioBuffer);
          circularAudioBuffer.flush();
        }
    });

    this.app.components['StreamingServer'].on('ready', () => {
        this.stopTranscription();
    });

    this.app.components['StreamingServer'].on('error', () => {
        this.stopTranscription();
    });
}