// Speech-aware session net for vLLM realtime, two jobs:
// - watchdog: sustained speech with zero transcription events = dead session
//   (rut, wedge, lost server event) -> fire, the caller re-sessions.
// - speech gate: after an explicit server session end, the caller defers the
//   new session until speech resumes (speechOnset), so music/silence never
//   causes session churn.
// Detector = Silero VAD (ONNX, frames of 512 samples @16 kHz, ~0.3 ms/frame).
// Inference is async: ingest() queues PCM, a serial pump scores frames and
// fires through the onFire callback.
//
// ENV:
//   ASR_VAD_WATCHDOG        enforce | observe | off   (default enforce)
//   ASR_VAD_WINDOW_MS       rolling window            (default 15000)
//   ASR_VAD_MIN_SPEECH_MS   speech needed in window   (default 8000)
//   ASR_VAD_SPEECH_PROB     Silero speech threshold   (default 0.5)
//   ASR_VAD_ONSET_MS        speech in the last 1 s to
//                           declare an onset          (default 400)
//   ASR_VAD_COOLDOWN_MS     min delay between fires   (default 60000)

const path = require('path');

const MODE = (process.env.ASR_VAD_WATCHDOG || 'enforce').toLowerCase();
const WINDOW_MS = parseInt(process.env.ASR_VAD_WINDOW_MS || '15000', 10);
const MIN_SPEECH_MS = parseInt(process.env.ASR_VAD_MIN_SPEECH_MS || '8000', 10);
const SPEECH_PROB = parseFloat(process.env.ASR_VAD_SPEECH_PROB || '0.5');
const ONSET_MS = parseInt(process.env.ASR_VAD_ONSET_MS || '400', 10);
const COOLDOWN_MS = parseInt(process.env.ASR_VAD_COOLDOWN_MS || '60000', 10);

const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 512;                    // Silero v5 frame @16 kHz
const FRAME_MS = (FRAME_SAMPLES * 1000) / SAMPLE_RATE;  // 32 ms
const MODEL_PATH = path.join(__dirname, 'models', 'silero_vad.onnx');
// Pending-PCM cap: inference is ~100x realtime, a deep queue means something
// is wrong; drop oldest instead of growing without bound.
const MAX_QUEUE_FRAMES = Math.ceil(5000 / FRAME_MS);

class SileroDetector {
    async init() {
        const ort = require('onnxruntime-node');
        this._ort = ort;
        this._session = await ort.InferenceSession.create(MODEL_PATH);
        this._state = new ort.Tensor(
            'float32', new Float32Array(2 * 1 * 128), [2, 1, 128]);
        this._sr = new ort.Tensor('int64', BigInt64Array.from([16000n]), [1]);
    }

    /** Float32Array[512] -> speech probability [0,1]. Serial calls only. */
    async prob(frame) {
        const input = new this._ort.Tensor('float32', frame, [1, FRAME_SAMPLES]);
        const out = await this._session.run(
            { input, state: this._state, sr: this._sr });
        this._state = out.stateN;
        return out.output.data[0];
    }
}

class VadWatchdog {
    /**
     * opts.logger  channel logger (warn/error/debug)
     * opts.onFire  called with a verdict when the watchdog trips
     * opts.detector  injectable detector (tests); defaults to Silero
     */
    constructor(opts = {}) {
        this.mode = ['enforce', 'observe'].includes(MODE) ? MODE : 'off';
        this.windowMs = WINDOW_MS;
        this.minSpeechMs = MIN_SPEECH_MS;
        this._logger = opts.logger || console;
        this._onFire = opts.onFire || (() => {});
        this._detector = opts.detector || new SileroDetector();
        this._ready = false;
        this._failed = false;
        this._pcmRemainder = Buffer.alloc(0);
        this._queue = [];             // Float32Array frames awaiting scoring
        this._pumping = false;
        this._speechFrames = [];      // timestamps of speech-scored frames
        this._lastSpeechTime = 0;
        this._lastEventTime = Date.now();
        this._lastFire = 0;
        this._audioMs = 0;

        if (this.mode !== 'off') {
            this._detector.init().then(() => {
                this._ready = true;
            }).catch((e) => {
                this._failed = true;
                this._logger.error(
                    `VAD watchdog disabled: Silero model failed to load (${e.message})`);
            });
        }
    }

    /** Transcription evidence (a delta arrived): the session is alive. */
    noteEvent(now) {
        this._lastEventTime = now;
    }

    /** New connection: restart the accounting, keep the acoustic state. */
    reset(now) {
        this._speechFrames = [];
        this._lastEventTime = now || Date.now();
        this._audioMs = 0;
    }

    /** >= ONSET_MS of speech within the last second: worth opening a session. */
    speechOnset(now) {
        now = now || Date.now();
        if (now - this._lastSpeechTime > 1000) return false;
        const oneSecAgo = now - 1000;
        let ms = 0;
        for (let i = this._speechFrames.length - 1; i >= 0; i--) {
            if (this._speechFrames[i] < oneSecAgo) break;
            ms += FRAME_MS;
        }
        return ms >= ONSET_MS;
    }

    /** Feed source PCM (S16LE 16 kHz mono). Fire happens via onFire. */
    ingest(buf, now) {
        if (this.mode === 'off' || this._failed || !this._ready) return;
        let pcm = this._pcmRemainder.length
            ? Buffer.concat([this._pcmRemainder, buf]) : buf;
        const frameBytes = FRAME_SAMPLES * 2;
        let off = 0;
        for (; off + frameBytes <= pcm.length; off += frameBytes) {
            const frame = new Float32Array(FRAME_SAMPLES);
            for (let i = 0; i < FRAME_SAMPLES; i++) {
                frame[i] = pcm.readInt16LE(off + i * 2) / 32768;
            }
            this._queue.push(frame);
        }
        this._pcmRemainder = Buffer.from(pcm.subarray(off));
        if (this._queue.length > MAX_QUEUE_FRAMES) {
            this._queue.splice(0, this._queue.length - MAX_QUEUE_FRAMES);
        }
        this._pump(now);
    }

    _pump(now) {
        if (this._pumping) return;
        this._pumping = true;
        (async () => {
            try {
                while (this._queue.length) {
                    const frame = this._queue.shift();
                    const p = await this._detector.prob(frame);
                    this._audioMs += FRAME_MS;
                    if (p >= SPEECH_PROB) {
                        this._speechFrames.push(now);
                        this._lastSpeechTime = now;
                    }
                    const cutoff = now - this.windowMs;
                    while (this._speechFrames.length
                           && this._speechFrames[0] < cutoff) {
                        this._speechFrames.shift();
                    }
                    const verdict = this._check(now);
                    if (verdict) this._onFire(verdict);
                }
            } catch (e) {
                this._logger.error(`VAD watchdog inference error: ${e.message}`);
            } finally {
                this._pumping = false;
            }
        })();
    }

    _check(now) {
        if (this._audioMs < this.windowMs) return null;
        if (this._lastFire && now - this._lastFire < COOLDOWN_MS) return null;
        if (now - this._lastEventTime < this.windowMs) return null;
        const speechMs = this._speechFrames.length * FRAME_MS;
        if (speechMs < this.minSpeechMs) return null;
        this._lastFire = now;
        this._speechFrames = [];
        return {
            mode: this.mode,
            speechMs: Math.round(speechMs),
            windowMs: this.windowMs,
            sinceEventMs: now - this._lastEventTime,
        };
    }
}

module.exports = { VadWatchdog, SileroDetector, FRAME_SAMPLES, FRAME_MS };
