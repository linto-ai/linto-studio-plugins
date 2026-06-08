const assert = require('assert');
const EventEmitter = require('eventemitter3');
const path = require('path');

// Regression guard for the acute Voxtral freeze at RoPE re-anchor.
//
// The transcriber used to send a mid-session `input_audio_buffer.commit` on
// hard silence (the "commit-drain"). On the vLLM side that commit can land
// while the engine is re-anchoring a long realtime session's positions
// ("Generation already in progress, ignoring commit"), stalling the stream's
// delta output for ~10s. The reference client (ws_load.py) sends no
// mid-session commit and passes re-anchors cleanly. This test pins the
// behaviour so the commit-drain is not silently re-introduced.

const mockLogger = {
    info() {}, warn() {}, error() {}, debug() {},
    getChannelLogger() {
        return { info() {}, warn() {}, error() {}, debug() {}, log() {} };
    }
};

class MockSecurity {
    safeDecrypt(text) { return text; }
}

class MockWebSocket extends EventEmitter {
    constructor(url, options) {
        super();
        this.readyState = 1;
        this.sentMessages = [];
        this.closed = false;
    }
    send(data) { this.sentMessages.push(data); }
    close() { this.closed = true; this.readyState = 3; }
    static get OPEN() { return 1; }
    static get CLOSED() { return 3; }
}

const transcriberPath = path.resolve(__dirname, '../ASR/openai_streaming/index.js');
const loggerPath = path.resolve(__dirname, '../logger.js');

function setupMocks() {
    const wsModulePath = require.resolve('ws');
    const liveSrtLibPath = require.resolve('live-srt-lib');

    const origWs = require.cache[wsModulePath];
    const origLiveSrtLib = require.cache[liveSrtLibPath];
    const origLogger = require.cache[loggerPath];

    require.cache[wsModulePath] = {
        id: wsModulePath, filename: wsModulePath, loaded: true,
        exports: MockWebSocket
    };
    require.cache[liveSrtLibPath] = {
        id: liveSrtLibPath, filename: liveSrtLibPath, loaded: true,
        exports: { Security: MockSecurity, logger: mockLogger, Model: {} }
    };
    require.cache[loggerPath] = {
        id: loggerPath, filename: loggerPath, loaded: true,
        exports: mockLogger
    };

    delete require.cache[transcriberPath];

    return function teardown() {
        if (origWs) require.cache[wsModulePath] = origWs;
        else delete require.cache[wsModulePath];
        if (origLiveSrtLib) require.cache[liveSrtLibPath] = origLiveSrtLib;
        else delete require.cache[liveSrtLibPath];
        if (origLogger) require.cache[loggerPath] = origLogger;
        else delete require.cache[loggerPath];
        delete require.cache[transcriberPath];
    };
}

describe('Segmentation: re-anchor freeze guard (no mid-session commit)', function () {
    let OpenAIStreamingTranscriber;
    let teardown;

    // Must exceed DRAIN_GRACE_MS (750) so the drain emits on the second tick.
    const GRACE_OVERSHOOT_MS = 800;
    // No sentence-ending punctuation -> forces the Priority-5 hard-silence path.
    const NO_PUNCT_TEXT = 'this is a longer test sentence without ending punctuation';

    before(function () {
        teardown = setupMocks();
        OpenAIStreamingTranscriber = require('../ASR/openai_streaming/index');
    });

    after(function () {
        if (teardown) teardown();
    });

    function makeTranscriber() {
        const session = { id: 'test-session' };
        const channel = {
            id: 'test-channel',
            transcriberProfile: {
                config: {
                    type: 'openai_streaming',
                    protocol: 'vllm',
                    endpoint: 'ws://localhost:8000',
                    languages: [{ candidate: 'fr-FR' }, { candidate: 'en-US' }]
                }
            }
        };
        const t = new OpenAIStreamingTranscriber(session, channel);
        t.start();              // creates the mock ws + vLLM protocol
        t._sessionReady = true;
        return t;
    }

    function commitsSent(t) {
        return t.ws.sentMessages
            .map(m => { try { return JSON.parse(m); } catch (e) { return {}; } })
            .filter(m => m.type === 'input_audio_buffer.commit');
    }

    it('does not send a commit when entering drain on hard silence', function () {
        const t = makeTranscriber();
        const base = 100000;
        t.accumulatedText = NO_PUNCT_TEXT;
        t.lastDeltaTime = base;

        t._runSegmentationTick(base + t.hardSilenceMs + 1);

        assert.strictEqual(t._draining, true, 'should be draining after hard silence');
        assert.strictEqual(commitsSent(t).length, 0, 'must not poke the server with a commit');
    });

    it('emits the segment after the grace period, still without any commit', function () {
        const t = makeTranscriber();
        const emitted = [];
        t.on('transcribed', p => emitted.push(p));

        const base = 100000;
        t.accumulatedText = NO_PUNCT_TEXT;
        t.lastDeltaTime = base;

        const drainStart = base + t.hardSilenceMs + 1;
        t._runSegmentationTick(drainStart);                         // enter drain
        t._runSegmentationTick(drainStart + GRACE_OVERSHOOT_MS);    // grace expired -> emit

        assert.strictEqual(emitted.length, 1, 'segment should be emitted after the grace period');
        assert.strictEqual(t._draining, false, 'drain should be cleared after emit');
        assert.strictEqual(commitsSent(t).length, 0, 'no mid-session commit at any point');
    });
});
