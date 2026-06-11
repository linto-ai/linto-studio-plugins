/**
 * Unit tests for ASR.flushFinals() — the stop-time drain that lets the
 * provider deliver its pending finals (e.g. Azure stopContinuousRecognitionAsync)
 * BEFORE the end-of-stream bot marker is published. Contract:
 *   - stops the provider WITH listeners still attached (in-flight finals are
 *     re-emitted as 'final')
 *   - idempotent (stop called at most once)
 *   - bounded: a hung provider.stop() cannot delay the marker past the timeout
 *   - sets _flushed so dispose() skips the redundant provider.stop()
 *   - no-op while paused (provider already stopped by pause())
 *
 * Same require-cache injection as test_asr_pause_resume.js: a channel with
 * enableLiveTranscripts:false forces the pilotable FakeTranscriber as provider.
 */

const assert = require('assert');
const path = require('path');
const { describe, it, before, after, beforeEach } = require('mocha');

const mockLogger = {
    info() {}, warn() {}, error() {}, debug() {}, log() {},
    getChannelLogger() {
        return { info() {}, warn() {}, error() {}, debug() {}, log() {} };
    }
};

const liveSrtLibPath = require.resolve('live-srt-lib');
const transcriberLoggerPath = path.resolve(__dirname, '../logger.js');
const asrIndexPath = path.resolve(__dirname, '../ASR/index.js');
const fakeIndexPath = path.resolve(__dirname, '../ASR/fake/index.js');

let teardown;

function setupMocks() {
    const origLib = require.cache[liveSrtLibPath];
    const origLogger = require.cache[transcriberLoggerPath];

    require.cache[liveSrtLibPath] = {
        id: liveSrtLibPath,
        filename: liveSrtLibPath,
        loaded: true,
        exports: {
            CircularBuffer: require('../../lib/circularbuffer.js'),
            logger: mockLogger,
            Model: {},
            Security: class {
                encrypt(t) { return t; }
                decrypt(t) { return t; }
                safeDecrypt(t) { return t; }
            },
        },
    };
    require.cache[transcriberLoggerPath] = {
        id: transcriberLoggerPath,
        filename: transcriberLoggerPath,
        loaded: true,
        exports: mockLogger,
    };
    delete require.cache[asrIndexPath];
    delete require.cache[fakeIndexPath];

    return function () {
        if (origLib) require.cache[liveSrtLibPath] = origLib; else delete require.cache[liveSrtLibPath];
        if (origLogger) require.cache[transcriberLoggerPath] = origLogger; else delete require.cache[transcriberLoggerPath];
        delete require.cache[asrIndexPath];
        delete require.cache[fakeIndexPath];
    };
}

describe('ASR.flushFinals()', () => {
    let ASR;

    const ORIG_SETTLE = process.env.ASR_STOP_SETTLE_MS;
    const ORIG_FLUSH = process.env.ASR_STOP_FLUSH_TIMEOUT_MS;

    before(() => {
        // Keep tests fast: minimal settle grace, generous flush timeout by
        // default. (Note: '0' would fall back to the 300ms default via `|| 300`,
        // so use 1ms to actually shorten the settle.)
        process.env.ASR_STOP_SETTLE_MS = '1';
        process.env.ASR_STOP_FLUSH_TIMEOUT_MS = '3000';
        teardown = setupMocks();
        ASR = require('../ASR/index.js');
    });

    after(() => {
        if (teardown) teardown();
        if (ORIG_SETTLE === undefined) delete process.env.ASR_STOP_SETTLE_MS; else process.env.ASR_STOP_SETTLE_MS = ORIG_SETTLE;
        if (ORIG_FLUSH === undefined) delete process.env.ASR_STOP_FLUSH_TIMEOUT_MS; else process.env.ASR_STOP_FLUSH_TIMEOUT_MS = ORIG_FLUSH;
    });

    function makeChannel(overrides = {}) {
        return Object.assign({
            id: 'test-channel-id',
            enableLiveTranscripts: false, // → FakeTranscriber provider
            keepAudio: false,
            transcriberProfile: { config: { type: 'fake', languages: [] } },
            translations: [],
        }, overrides);
    }

    async function makeReadyAsr() {
        const asr = new ASR({ id: 'test-session-id' }, makeChannel());
        await new Promise((r) => setImmediate(r));
        await asr._transitionLock;
        return asr;
    }

    it('stops the provider once and marks the ASR closed', async () => {
        const asr = await makeReadyAsr();
        assert.strictEqual(asr.provider.stopCount, 0);

        await asr.flushFinals();

        assert.strictEqual(asr.provider.stopCount, 1);
        assert.strictEqual(asr._flushed, true);
        assert.strictEqual(asr.state, ASR.states.CLOSED);
    });

    it('publishes a final emitted by the provider DURING stop (listeners attached)', async () => {
        const asr = await makeReadyAsr();
        const finals = [];
        asr.on('final', (f) => finals.push(f));

        // Simulate Azure flushing a pending recognized result inside stop().
        asr.provider.stop = function () {
            this.stopCount += 1;
            this.emit('transcribed', { text: 'last words', segmentId: 1, astart: 0, locutor: 'spk' });
            this.emit('closed');
        };

        await asr.flushFinals();

        assert.ok(finals.some((f) => f.text === 'last words'),
            'in-flight provider final must be re-emitted as a final before the marker');
    });

    it('is idempotent — a second flushFinals does not stop again', async () => {
        const asr = await makeReadyAsr();
        await asr.flushFinals();
        await asr.flushFinals();
        assert.strictEqual(asr.provider.stopCount, 1, 'provider.stop called at most once');
    });

    it('is bounded — a provider.stop() that never resolves still settles', async () => {
        process.env.ASR_STOP_FLUSH_TIMEOUT_MS = '50';
        try {
            const asr = await makeReadyAsr();
            asr.provider.stop = () => new Promise(() => {}); // never resolves
            const start = Date.now();
            await asr.flushFinals();
            assert.ok(Date.now() - start < 1000, 'flushFinals must not hang on a stuck provider');
            assert.strictEqual(asr.state, ASR.states.CLOSED);
        } finally {
            process.env.ASR_STOP_FLUSH_TIMEOUT_MS = '3000';
        }
    });

    it('lets dispose() skip the redundant provider.stop() after a flush', async () => {
        const asr = await makeReadyAsr();
        const provider = asr.provider; // dispose() nulls asr.provider — keep a ref
        await asr.flushFinals();
        const stopAfterFlush = provider.stopCount; // 1
        await asr.dispose();
        assert.strictEqual(provider.stopCount, stopAfterFlush,
            'dispose() must not call provider.stop() again once _flushed is set');
    });

    it('is a no-op while paused (provider already stopped by pause())', async () => {
        const asr = await makeReadyAsr();
        await asr.pause();
        const stopAfterPause = asr.provider.stopCount; // 1 (from pause)

        await asr.flushFinals();

        assert.strictEqual(asr._flushed, false, 'paused ASR must not be marked flushed');
        assert.strictEqual(asr.provider.stopCount, stopAfterPause,
            'flushFinals must not stop the provider again while paused');
    });
});
