/**
 * Unit tests for the ASR pause/resume wrapper.
 *
 * The wrapper `Transcriber/ASR/index.js` exposes pause()/resume() with:
 *   - idempotence (pause × N = stop called only once)
 *   - serialization via _transitionLock
 *   - audioBuffer flush during pause
 *   - transcribe() short-circuits and flushes during pause
 *   - segmentId preserved across pause/resume cycles
 *
 * We inject the require-cache to provide a minimal live-srt-lib and a neutral
 * logger, then load ASR with a channel `enableLiveTranscripts: false`, which
 * forces the use of FakeTranscriber (a pilotable mock provider).
 */

const assert = require('assert');
const path = require('path');
const { describe, it, before, after, beforeEach } = require('mocha');

// ---- Mocks ---------------------------------------------------------------

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

// ---- Test environment ----------------------------------------------------

// Sufficient buffer for one MIN_AUDIO_BUFFER worth of bytes; SAMPLE_RATE/
// BYTES_PER_SAMPLE come from tests.js. We override MIN_AUDIO_BUFFER here so
// that small synthetic buffers still trigger provider.transcribe().
const ORIG_MIN_AUDIO_BUFFER = process.env.MIN_AUDIO_BUFFER;

describe('ASR pause/resume', () => {
    let ASR;
    let FakeTranscriber;

    before(() => {
        process.env.MIN_AUDIO_BUFFER = '1'; // 1 ms => 1 byte threshold given test env
        teardown = setupMocks();
        ASR = require('../ASR/index.js');
        FakeTranscriber = require('../ASR/fake/index.js');
    });

    after(() => {
        if (teardown) teardown();
        if (ORIG_MIN_AUDIO_BUFFER === undefined) delete process.env.MIN_AUDIO_BUFFER;
        else process.env.MIN_AUDIO_BUFFER = ORIG_MIN_AUDIO_BUFFER;
    });

    function makeSession() {
        return { id: 'test-session-id' };
    }

    function makeChannel(overrides = {}) {
        return Object.assign({
            id: 'test-channel-id',
            // enableLiveTranscripts:false forces ASR.init() to instantiate
            // FakeTranscriber as provider — which is exactly the pilotable
            // mock we need.
            enableLiveTranscripts: false,
            keepAudio: false,
            transcriberProfile: { config: { type: 'fake', languages: [] } },
            translations: [],
        }, overrides);
    }

    /**
     * Build an ASR instance and wait for init() to finish.
     * After this resolves: provider is FakeTranscriber, started once,
     * state is READY (because FakeTranscriber.start() emits 'ready'
     * synchronously, which the wrapper's listener catches).
     */
    async function makeReadyAsr() {
        const asr = new ASR(makeSession(), makeChannel());
        // init() runs async without await in constructor; let it settle.
        await new Promise((r) => setImmediate(r));
        // _transitionLock would also serialize; await it for safety.
        await asr._transitionLock;
        return asr;
    }

    // -------- Suite 1 — Idempotence --------------------------------------

    describe('idempotence', () => {
        it('pause() then pause() leaves stopCount at 1', async () => {
            const asr = await makeReadyAsr();
            assert.strictEqual(asr.provider.startCount, 1);
            assert.strictEqual(asr.provider.stopCount, 0);

            await asr.pause();
            await asr.pause();

            assert.strictEqual(asr.paused, true);
            assert.strictEqual(asr.provider.stopCount, 1, 'stop called only once across two pauses');
        });

        it('resume() on a non-paused ASR is a no-op', async () => {
            const asr = await makeReadyAsr();
            const startBefore = asr.provider.startCount;

            await asr.resume();

            assert.strictEqual(asr.paused, false);
            assert.strictEqual(asr.provider.startCount, startBefore,
                'resume() without prior pause() must not call provider.start()');
        });

        it('resume() × 2 after pause leaves only one extra start', async () => {
            const asr = await makeReadyAsr();
            const startBefore = asr.provider.startCount; // 1

            await asr.pause();
            await asr.resume();
            await asr.resume(); // second resume must be a no-op (paused already false)

            assert.strictEqual(asr.provider.startCount, startBefore + 1,
                'second resume must not call provider.start() again');
        });
    });

    // -------- Suite 2 — Drain audio pendant pause -------------------------

    describe('audio drain while paused', () => {
        it('transcribe() does not call provider.transcribe() while paused', async () => {
            const asr = await makeReadyAsr();
            await asr.pause();

            const callsBefore = asr.provider.transcribeCallCount;
            asr.transcribe(Buffer.from([1, 2, 3, 4]));
            asr.transcribe(Buffer.from([5, 6, 7, 8]));
            asr.transcribe(Buffer.from([9, 10, 11, 12]));

            assert.strictEqual(asr.provider.transcribeCallCount, callsBefore,
                'provider.transcribe must NOT be invoked while ASR is paused');
        });

        it('audioBuffer remains empty after several paused transcribe() calls', async () => {
            const asr = await makeReadyAsr();
            await asr.pause();

            asr.transcribe(Buffer.from([1, 2, 3]));
            asr.transcribe(Buffer.from([4, 5, 6]));
            asr.transcribe(Buffer.from([7, 8, 9]));

            // Pointer must remain at 0 — buffer drained on every paused call.
            assert.strictEqual(asr.audioBuffer.pointer, 0,
                'audioBuffer pointer must stay at 0 after paused transcribe() calls');
            assert.strictEqual(asr.audioBuffer.getAudioBuffer().length, 0);
        });
    });

    // -------- Suite 3 — Cycle stop+start propre ---------------------------

    describe('clean stop+start cycle', () => {
        it('pause+resume yields stopCount=1, startCount=2 (1 initial + 1 resume)', async () => {
            const asr = await makeReadyAsr();
            assert.strictEqual(asr.provider.startCount, 1, 'init() should have started once');

            await asr.pause();
            await asr.resume();

            assert.strictEqual(asr.provider.stopCount, 1);
            assert.strictEqual(asr.provider.startCount, 2);
        });

        it('after resume, paused flag is false and state is not paused-related', async () => {
            const asr = await makeReadyAsr();
            await asr.pause();
            assert.strictEqual(asr.paused, true);

            await asr.resume();

            assert.strictEqual(asr.paused, false);
            // After resume, FakeTranscriber.start() emits 'ready' synchronously
            // which the wrapper turns into state=READY. CONNECTING is also
            // acceptable transient. Accept any of CONNECTING/READY.
            assert.ok(
                asr.state === ASR.states.READY || asr.state === ASR.states.CONNECTING,
                `expected state READY or CONNECTING after resume, got ${asr.state}`
            );
        });

        it('after resume, transcribe() reaches provider.transcribe() again', async () => {
            const asr = await makeReadyAsr();
            await asr.pause();
            await asr.resume();

            const callsBefore = asr.provider.transcribeCallCount;
            // Ensure state allows forwarding.
            asr.state = ASR.states.READY;
            asr.transcribe(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));

            assert.strictEqual(asr.provider.transcribeCallCount, callsBefore + 1,
                'provider.transcribe must be invoked again after resume');
        });
    });

    // -------- Suite 4 — Transition serialization --------------------------

    describe('transition serialization', () => {
        it('parallel pause()+resume() preserves order via _transitionLock', async () => {
            const asr = await makeReadyAsr();

            // Fire both in parallel without awaiting between calls.
            const pPause = asr.pause();
            const pResume = asr.resume();
            await Promise.all([pPause, pResume]);

            // Order matters: pause must run first (sets paused=true and stops),
            // then resume picks up the paused state and restarts.
            assert.strictEqual(asr.provider.stopCount, 1,
                'pause must have run and called stop exactly once');
            assert.strictEqual(asr.provider.startCount, 2,
                'resume must have run AFTER pause and called start a second time');
            assert.strictEqual(asr.paused, false,
                'final state after pause→resume must be unpaused');
        });

        it('pause() × 3 in parallel is idempotent (single stop)', async () => {
            const asr = await makeReadyAsr();

            const p1 = asr.pause();
            const p2 = asr.pause();
            const p3 = asr.pause();
            await Promise.all([p1, p2, p3]);

            assert.strictEqual(asr.paused, true);
            assert.strictEqual(asr.provider.stopCount, 1,
                'three concurrent pause() calls must result in exactly one stop()');
        });
    });

    // -------- Suite 4b — State after pause -------------------------------

    describe('state after pause()', () => {
        it('state becomes CLOSED synchronously after pause() resolves', async () => {
            const asr = await makeReadyAsr();
            assert.notStrictEqual(asr.state, ASR.states.CLOSED, 'precondition: not closed');

            await asr.pause();

            assert.strictEqual(asr.state, ASR.states.CLOSED,
                'state must be CLOSED right after pause() completes — external readers should never see READY while paused');
        });
    });

    // -------- Suite 5b — Transition lock robustness ----------------------

    describe('transition lock robustness', () => {
        it('init() is registered in _transitionLock — pause() right after construction waits for it', async () => {
            // Build an ASR but slow down provider.start() so we can race a pause()
            // against an in-flight init(). We monkey-patch FakeTranscriber.start
            // to await a manually-resolved gate before emitting 'ready'.
            let releaseStart;
            const startGate = new Promise((r) => { releaseStart = r; });
            const origStart = FakeTranscriber.prototype.start;
            const startOrder = [];
            FakeTranscriber.prototype.start = async function () {
                startOrder.push('start-begin');
                await startGate;
                startOrder.push('start-end');
                return origStart.call(this);
            };

            const asr = new ASR(makeSession(), makeChannel());
            // Fire pause() immediately — before init() has finished provider.start().
            const pPause = asr.pause();
            // Mark when pause "would-have" run independently of init.
            const pPauseObserved = pPause.then(() => startOrder.push('pause-end'));

            // Release init's start() gate.
            releaseStart();
            await pPauseObserved;

            // The chain must serialize init() (start-end) BEFORE pause-end.
            FakeTranscriber.prototype.start = origStart;
            assert.deepStrictEqual(
                startOrder,
                ['start-begin', 'start-end', 'pause-end'],
                'pause() must wait for init()/provider.start() to complete'
            );
            assert.strictEqual(asr.paused, true);
        });

        it('_transitionLock survives a synchronous throw inside a queued transition', async () => {
            const asr = await makeReadyAsr();

            // Inject a transition that throws synchronously inside the chained fn.
            const broken = asr._chainTransition(async () => {
                throw new Error('boom');
            });
            // Swallow the rejection here so it doesn't escape to the test runner.
            await broken.catch(() => {});

            // The next transition must still run despite the previous rejection.
            await asr.pause();
            assert.strictEqual(asr.paused, true,
                'pause() after a rejected transition must still execute');

            await asr.resume();
            assert.strictEqual(asr.paused, false,
                'resume() after a rejected transition must still execute');
        });
    });

    // -------- Suite 5 — segmentId preservation ----------------------------

    describe('segmentId preservation', () => {
        it('segmentId is preserved across pause+resume', async () => {
            const asr = await makeReadyAsr();

            // Bump segmentId to a non-default value to prove it's not reset.
            asr.segmentId = 42;

            await asr.pause();
            assert.strictEqual(asr.segmentId, 42, 'pause() must not touch segmentId');

            await asr.resume();
            assert.strictEqual(asr.segmentId, 42, 'resume() must not touch segmentId');
        });
    });

    // -------- Suite 6 — dual recognizer origin-tagging --------------------
    //
    // In Microsoft dual mode (diarization + translation) two recognizers emit
    // 'transcribed' for the same spoken segment: the primary (ConversationTranscriber,
    // isPrimary=true, carries the speaker) and the secondary (TranslationRecognizer,
    // isPrimary=false, carries only translations). The wrapper must:
    //   - emit a 'final' for both (so ASREvents can route translations),
    //   - advance segmentId ONLY on primary finals,
    //   - tag each final so ASREvents drops the secondary's canonical line.
    // This replaces the old fragile modulo-2 `_dualFinalCount` counter.
    describe('dual recognizer origin-tagging (segmentId progression)', () => {
        // Drive the provider directly via emit() so we control interleaving and
        // cardinality (Azure gives no ordering/cardinality guarantee across the
        // two independent streams).
        function emitFinal(asr, text, isPrimary) {
            asr.provider.emit('transcribed', { text, isPrimary });
        }

        it('only primary finals advance segmentId; secondary finals attach to current segment', async () => {
            const asr = await makeReadyAsr();
            const finals = [];
            asr.on('final', (t) => finals.push({ segmentId: t.segmentId, isPrimary: t.isPrimary }));

            const start = asr.segmentId;
            // Segment N: primary speaks, then its translation arrives.
            emitFinal(asr, 'hello', true);
            emitFinal(asr, 'bonjour', false);
            // Segment N+1: primary speaks, then translation.
            emitFinal(asr, 'world', true);
            emitFinal(asr, 'monde', false);

            assert.strictEqual(finals.length, 4, 'every final (primary + secondary) is emitted');
            // Two primary finals → segmentId advanced exactly twice.
            assert.strictEqual(asr.segmentId, start + 2);
            // Primary "hello" and its secondary "bonjour" share the same segmentId.
            assert.strictEqual(finals[0].segmentId, start);
            assert.strictEqual(finals[1].segmentId, start);
            assert.strictEqual(finals[0].isPrimary, true);
            assert.strictEqual(finals[1].isPrimary, false);
            // Next segment.
            assert.strictEqual(finals[2].segmentId, start + 1);
            assert.strictEqual(finals[3].segmentId, start + 1);
        });

        it('extra/out-of-order secondary finals never advance segmentId (robust to cardinality skew)', async () => {
            const asr = await makeReadyAsr();
            const start = asr.segmentId;

            // Pathological stream: many translation finals, occasional primary.
            emitFinal(asr, 'a', false);
            emitFinal(asr, 'b', false);
            emitFinal(asr, 'one', true);   // +1
            emitFinal(asr, 'c', false);
            emitFinal(asr, 'd', false);
            emitFinal(asr, 'e', false);
            emitFinal(asr, 'two', true);   // +1

            assert.strictEqual(asr.segmentId, start + 2,
                'segmentId advances exactly once per primary final, regardless of secondary count/order');
        });

        it('providers that do not tag isPrimary advance segmentId on every final (non-dual unchanged)', async () => {
            const asr = await makeReadyAsr();
            const start = asr.segmentId;

            // No isPrimary field at all (amazon/linto/openai/fake, single-recognizer Azure).
            asr.provider.emit('transcribed', { text: 'one' });
            asr.provider.emit('transcribed', { text: 'two' });
            asr.provider.emit('transcribed', { text: 'three' });

            assert.strictEqual(asr.segmentId, start + 3,
                'untagged finals must each advance segmentId (legacy single-recognizer behaviour)');
        });
    });
});
