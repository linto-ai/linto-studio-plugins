const assert = require('assert');
const { setupMocks, fromTranscriber } = require('./helpers/asr_mocks');

// Mute watchdog suite: guards against the vLLM realtime "silent collapse"
// (server streams empty deltas at frame rate while real speech is flowing).
// The watchdog counts VOICED audio ms since the last non-empty delta, so
// legitimate silence never triggers it, and empty deltas do not disarm it.

function makePcm(ms, amplitude) {
    // 16 kHz mono 16-bit LE: 16 samples (32 bytes) per ms
    const samples = ms * 16;
    const buf = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) {
        buf.writeInt16LE(i % 2 === 0 ? amplitude : -amplitude, i * 2);
    }
    return buf;
}

const VOICED_100MS = makePcm(100, 8000); // ~-12 dBFS, well above -45
const QUIET_100MS = makePcm(100, 100);   // ~-50 dBFS, below -45
const SILENT_100MS = Buffer.alloc(3200); // digital silence

describe('OpenAIStreamingTranscriber mute watchdog', function () {
    let OpenAIStreamingTranscriber;
    let teardown;

    before(function () {
        // 300ms of voiced audio triggers the resession. Read at require time.
        process.env.ASR_MUTE_WATCHDOG_SPEECH_MS = '300';
        teardown = setupMocks({ invalidate: [fromTranscriber('ASR/openai_streaming/index.js')] });
        OpenAIStreamingTranscriber = require('../ASR/openai_streaming/index');
    });

    after(function () {
        if (teardown) teardown();
        delete process.env.ASR_MUTE_WATCHDOG_SPEECH_MS;
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

    function emitSessionCreated(t) {
        t.ws.emit('message', JSON.stringify({ type: 'session.created', id: 'srv-1' }));
    }

    function emitPartial(t, text) {
        t.ws.emit('message', JSON.stringify({ type: 'transcription.delta', delta: text }));
    }

    function startArmed(t) {
        t.start();
        emitSessionCreated(t);
        t.transcribe(VOICED_100MS); // first audio arms the session
    }

    // ------------------------------------------------------------------
    // Voiced-ms accounting
    // ------------------------------------------------------------------

    it('counts chunk duration only when RMS is above the threshold', function () {
        const t = createTranscriber();
        assert.strictEqual(t._voicedMs(VOICED_100MS), 100);
        assert.strictEqual(t._voicedMs(QUIET_100MS), 0);
        assert.strictEqual(t._voicedMs(SILENT_100MS), 0);
        assert.strictEqual(t._voicedMs(Buffer.alloc(0)), 0);
    });

    it('accumulates voiced audio and ignores silence', function () {
        const t = createTranscriber();
        t.start();
        t.transcribe(VOICED_100MS);
        t.transcribe(SILENT_100MS);
        t.transcribe(VOICED_100MS);
        assert.strictEqual(t._speechMsSinceLastText, 200);
        t.stop();
    });

    it('resets the counter on start()', function () {
        const t = createTranscriber();
        t._speechMsSinceLastText = 9999;
        t.start();
        assert.strictEqual(t._speechMsSinceLastText, 0);
        t.stop();
    });

    // ------------------------------------------------------------------
    // Reset semantics: only non-empty text disarms
    // ------------------------------------------------------------------

    it('is reset by a non-empty delta', function () {
        const t = createTranscriber();
        startArmed(t);
        t.transcribe(VOICED_100MS);
        t.transcribe(VOICED_100MS);
        emitPartial(t, 'Bonjour tout le monde.');
        assert.strictEqual(t._speechMsSinceLastText, 0);
        t._runSegmentationTick(Date.now());
        assert.strictEqual(t._muteResessions, 0);
        t.stop();
    });

    it('is NOT reset by empty deltas (the rut signature)', function () {
        const t = createTranscriber();
        startArmed(t);
        t.transcribe(VOICED_100MS);
        t.transcribe(VOICED_100MS);
        emitPartial(t, '');
        emitPartial(t, '');
        assert.strictEqual(t._speechMsSinceLastText, 300);
        t.stop();
    });

    // ------------------------------------------------------------------
    // Trigger
    // ------------------------------------------------------------------

    it('forces a fresh session after the voiced-audio threshold with no text', function () {
        const t = createTranscriber();
        startArmed(t);
        t.transcribe(VOICED_100MS);
        t.transcribe(VOICED_100MS); // 300ms voiced total
        const wsBefore = t.ws;

        t._runSegmentationTick(Date.now());

        assert.strictEqual(t._muteResessions, 1);
        assert.strictEqual(t._speechMsSinceLastText, 0);
        assert.strictEqual(wsBefore.closed, true);       // stop() closed the socket
        assert.strictEqual(t._setupTimers.length, 1);    // reconnect scheduled
        assert.strictEqual(t._watchdogRetries, 0);       // separate accounting
        t.stop(); // clears the pending reconnect timer
    });

    it('never triggers on legitimate silence, whatever the duration', function () {
        const t = createTranscriber();
        startArmed(t);
        for (let i = 0; i < 50; i++) t.transcribe(SILENT_100MS); // 5s of silence
        t._runSegmentationTick(Date.now());
        assert.strictEqual(t._muteResessions, 0);
        assert.strictEqual(t.ws.closed, false);
        t.stop();
    });

    it('gives the fresh session a clean window after a mute resession', function () {
        const t = createTranscriber();
        startArmed(t);
        t.transcribe(VOICED_100MS);
        t.transcribe(VOICED_100MS);
        t._runSegmentationTick(Date.now()); // resession #1
        assert.strictEqual(t._muteResessions, 1);

        // Audio arriving while the reconnect is pending accumulates, but
        // start() resets the window for the fresh session.
        t.transcribe(VOICED_100MS);
        t.start();
        assert.strictEqual(t._speechMsSinceLastText, 0);
        t._runSegmentationTick(Date.now());
        assert.strictEqual(t._muteResessions, 1); // no immediate re-trigger
        t.stop();
    });
});

describe('OpenAIStreamingTranscriber mute watchdog disabled', function () {
    let OpenAIStreamingTranscriber;
    let teardown;

    before(function () {
        process.env.ASR_MUTE_WATCHDOG_SPEECH_MS = '0';
        teardown = setupMocks({ invalidate: [fromTranscriber('ASR/openai_streaming/index.js')] });
        OpenAIStreamingTranscriber = require('../ASR/openai_streaming/index');
    });

    after(function () {
        if (teardown) teardown();
        delete process.env.ASR_MUTE_WATCHDOG_SPEECH_MS;
    });

    it('accumulates nothing and never triggers when set to 0', function () {
        const session = { id: 'sess-1' };
        const channel = {
            id: 'chan-1',
            transcriberProfile: {
                config: {
                    type: 'openai_streaming',
                    endpoint: 'ws://localhost:8000',
                    model: 'test-model',
                    protocol: 'vllm',
                    languages: [{ candidate: 'fr-FR' }]
                }
            }
        };
        const t = new OpenAIStreamingTranscriber(session, channel);
        t.start();
        t.ws.emit('message', JSON.stringify({ type: 'session.created', id: 'srv-1' }));
        t.transcribe(makePcm(100, 8000));
        t.transcribe(makePcm(100, 8000));
        t.transcribe(makePcm(100, 8000));
        t.transcribe(makePcm(100, 8000));
        assert.strictEqual(t._speechMsSinceLastText, 0);
        t._runSegmentationTick(Date.now());
        assert.strictEqual(t._muteResessions, 0);
        t.stop();
    });
});
