const assert = require('assert');
const { setupMocks, fromTranscriber } = require('./helpers/asr_mocks');

// Silence-fill pacing suite.
// The vLLM realtime server needs a CONTINUOUS audio stream. SRT provides it by
// construction (GStreamer emits silent PCM at 1x through speech gaps); the
// WebSocket path does not, so a silent/bursty WS client starves the server and
// the realtime generation wedges. The pacing pump appends digital silence to
// keep the audio timeline level with the wall clock. These tests pin the two
// contracts that matter:
//   1. NON-REGRESSION: when audio flows at real-time (SRT), the pump injects
//      nothing -- the SRT byte stream is untouched.
//   2. FIX: on a gap (WS silence), the pump fills exactly enough silence to
//      bring the audio timeline back to the wall clock.

// PCM S16LE 16kHz mono: 32 bytes/ms. Non-zero fill so real audio is trivially
// distinguishable from injected (all-zero) silence.
const PCM_BYTES_PER_MS = 32;
function pcm(ms) { return Buffer.alloc(ms * PCM_BYTES_PER_MS, 1); }

function appends(t) {
    return t.ws.sentMessages
        .map(m => JSON.parse(m))
        .filter(m => m.type === 'input_audio_buffer.append');
}
// Injected silence is a faint noise floor (dither), not exact zeros: every
// sample stays at a tiny amplitude, far below the real-audio marker (value 1
// bytes -> int16 257 in pcm()).
function isSilent(appendMsg) {
    const buf = Buffer.from(appendMsg.audio, 'base64');
    for (let i = 0; i + 1 < buf.length; i += 2) {
        if (Math.abs(buf.readInt16LE(i)) > 16) return false;
    }
    return true;
}
function silenceAppends(t) {
    return appends(t).filter(isSilent).length;
}

describe('OpenAIStreamingTranscriber silence-fill pacing', function () {
    let OpenAIStreamingTranscriber;
    let teardown;

    before(function () {
        teardown = setupMocks({ invalidate: [fromTranscriber('ASR/openai_streaming/index.js')] });
        OpenAIStreamingTranscriber = require('../ASR/openai_streaming/index');
    });

    after(function () {
        if (teardown) teardown();
    });

    function createTranscriber(configOverrides = {}) {
        const session = { id: 'sess-1' };
        const channel = {
            id: 'chan-1',
            transcriberProfile: {
                config: {
                    type: 'openai_streaming',
                    endpoint: 'ws://localhost:8000',
                    model: 'test-model',
                    protocol: 'vllm',
                    languages: [{ candidate: 'fr-FR' }],
                    ...configOverrides
                }
            }
        };
        return new OpenAIStreamingTranscriber(session, channel);
    }

    // Arm the session (update + commit sent), then take over the pacing clock:
    // stop the real interval so ticks are driven explicitly, and anchor the
    // stream start at t=1000 with an empty audio timeline.
    function armManual() {
        const t = createTranscriber();
        t.start();
        t.ws.emit('message', JSON.stringify({ type: 'session.created', id: 'srv-1' }));
        t._stopPacing();
        t._streamStartWall = 1000;
        t._audioMsAppended = 0;
        return t;
    }

    // ------------------------------------------------------------------
    // NON-REGRESSION: continuous real-time audio -> pump stays silent
    // ------------------------------------------------------------------
    it('injects no silence while audio flows at real-time (SRT path unchanged)', function () {
        const t = armManual();

        // 3 s of audio arriving in 100 ms slices, in lockstep with the clock.
        for (let ms = 100; ms <= 3000; ms += 100) {
            t.transcribe(pcm(100));                 // real audio: clock += 100
            const filled = t._runPacingTick(1000 + ms); // wall clock advances 100 too
            assert.strictEqual(filled, 0, `unexpected silence at ${ms}ms`);
        }

        assert.strictEqual(silenceAppends(t), 0, 'no silence append must be sent');
        // Every append carried real (non-zero) audio.
        assert.strictEqual(appends(t).length, 30);
        t.stop();
    });

    it('injects nothing when audio runs AHEAD of the wall clock (burst)', function () {
        const t = armManual();
        t.transcribe(pcm(2000));                    // 2 s delivered in a burst
        const filled = t._runPacingTick(1500);      // only 500 ms of wall clock elapsed
        assert.strictEqual(filled, 0);
        assert.strictEqual(silenceAppends(t), 0);
        t.stop();
    });

    // ------------------------------------------------------------------
    // FIX: a gap in the client audio is filled with silence up to wall-clock
    // ------------------------------------------------------------------
    it('fills silence to the wall clock on a client gap', function () {
        const t = armManual();
        t.transcribe(pcm(200));                     // 200 ms real audio, clock = 200

        // 1 s of client silence: wall clock is now 1000 + 200 + 1000 = 2200.
        const filled = t._runPacingTick(2200);

        assert.strictEqual(filled, 1000, 'should fill exactly the 1000ms deficit');
        // Audio timeline is back level with the wall clock (200 real + 1000 fill).
        assert.strictEqual(t._audioMsAppended, 1200);
        assert.strictEqual(t._audioMsAppended, 2200 - t._streamStartWall);
        // The fill was digital silence, chunked into 200ms appends (1000/200 = 5).
        assert.strictEqual(silenceAppends(t), 5);
        t.stop();
    });

    it('stays within the keepalive grace without filling (tolerates jitter)', function () {
        const t = armManual();
        t.transcribe(pcm(200));                     // clock = 200
        // Deficit of exactly the grace threshold must NOT trigger a fill.
        const filled = t._runPacingTick(1000 + 200 + t._silenceKeepaliveMs);
        assert.strictEqual(filled, 0);
        assert.strictEqual(silenceAppends(t), 0);
        t.stop();
    });

    it('caps a single fill at SILENCE_FILL_MAX_MS on a very long gap', function () {
        const t = armManual();
        t.transcribe(pcm(100));                     // clock = 100
        // 60 s gap: one tick must not inject the whole minute at once.
        const filled = t._runPacingTick(1000 + 60000);
        assert.strictEqual(filled, 2000, 'single fill capped at 2000ms');
        t.stop();
    });

    // ------------------------------------------------------------------
    // Guards
    // ------------------------------------------------------------------
    it('injects nothing before any real audio (session that never streams)', function () {
        const t = createTranscriber();
        t.start();
        t.ws.emit('message', JSON.stringify({ type: 'session.created', id: 'srv-1' }));
        t._stopPacing();
        // No transcribe() call: _streamStartWall stays null.
        assert.strictEqual(t._streamStartWall, null);
        assert.strictEqual(t._runPacingTick(1e9), 0);
        assert.strictEqual(appends(t).length, 0);
        t.stop();
    });

    it('is a no-op when disabled (ASR_SILENCE_KEEPALIVE_MS=0)', function () {
        const t = armManual();
        t._silenceKeepaliveMs = 0;                  // simulate the env kill switch
        t.transcribe(pcm(100));
        const filled = t._runPacingTick(1000 + 60000); // huge gap
        assert.strictEqual(filled, 0);
        assert.strictEqual(silenceAppends(t), 0);
        t.stop();
    });

    it('does not resume pacing after stop()', function () {
        const t = armManual();
        t.transcribe(pcm(100));
        t.stop();
        // ws is closed by stop(); a tick must be inert.
        const filled = t._runPacingTick(1000 + 60000);
        assert.strictEqual(filled, 0);
    });
});
