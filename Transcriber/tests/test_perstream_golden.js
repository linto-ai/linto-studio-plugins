/**
 * T0 — GOLDEN segmentId sequence (BLOCKING gate for the perStream work).
 *
 * Captures, against the CURRENT (legacy) ASR/index.js behaviour, the exact
 * sequence of segmentId values produced by a Microsoft-style
 * primary / secondary / error-final interleaving on an ASR built WITHOUT a
 * segmentAllocator. The perStream change introduces an optional
 * `segmentAllocator` that, when present, sources segmentId from a shared
 * per-channel counter and neutralizes the two legacy `this.segmentId++`.
 *
 * The contract this test pins: WITHOUT a segmentAllocator the produced
 * segmentId sequence MUST be byte-identical to the legacy behaviour. The
 * GOLDEN array below was captured on `main` (segmentAllocator absent) and must
 * stay green both before AND after the ASR/index.js change. If it ever changes,
 * the additivity guarantee is broken — DO NOT update the GOLDEN to make it pass.
 *
 * Same plumbing as test_asr_native_speaker.js: inject mocked live-srt-lib +
 * neutral logger via setupMocks, drive the real ASR/index.js against
 * FakeTranscriber (enableLiveTranscripts:false) by emitting provider events.
 */

const assert = require('assert');
const { describe, it, before, after } = require('mocha');
const { setupMocks, fromTranscriber } = require('./helpers/asr_mocks');

const ASR_MOCK_OPTS = {
    invalidate: [fromTranscriber('ASR/index.js'), fromTranscriber('ASR/fake/index.js')],
    mockWs: false,
    circularBuffer: true,
};

// The legacy segmentId sequence, captured on `main`. Each entry is
// [eventType, segmentId] in emission order. See the driving sequence in the
// test body for the exact interleaving that produces it.
const GOLDEN = [
    ['partial', 1],
    ['final', 1],
    ['final', 1],
    ['partial', 2],
    ['final', 2],
    ['final', 3], // error-final uses this.segmentId then advances
    ['final', 4],
    ['final', 4],
];

let teardown;

describe('T0 golden segmentId sequence (legacy, no segmentAllocator)', () => {
    let ASR;

    before(() => {
        teardown = setupMocks(ASR_MOCK_OPTS);
        ASR = require('../ASR/index.js');
    });

    after(() => {
        if (teardown) teardown();
    });

    function makeSession() {
        return { id: 'golden-session-id' };
    }

    function makeChannel() {
        return {
            id: 'golden-channel-id',
            enableLiveTranscripts: false, // forces FakeTranscriber as provider
            keepAudio: false,
            transcriberProfile: { config: { type: 'fake', languages: [] } },
            translations: [],
        };
    }

    async function makeAsr(options = {}) {
        const asr = new ASR(makeSession(), makeChannel(), options);
        await new Promise((r) => setImmediate(r));
        await asr._transitionLock;
        return asr;
    }

    // Drive the canonical primary/secondary/error interleaving and record the
    // segmentId stamped on every emitted partial/final, in order.
    async function runSequence(options) {
        const asr = await makeAsr(options);
        const recorded = [];
        asr.on('partial', (t) => recorded.push(['partial', t.segmentId]));
        asr.on('final', (t) => recorded.push(['final', t.segmentId]));

        asr.provider.emit('transcribing', { text: 'a', isPrimary: true });          // partial seg 1
        asr.provider.emit('transcribed', { text: 'a final', isPrimary: true });     // final seg 1, ++ -> 2
        asr.provider.emit('transcribed', { text: 'a trans', isPrimary: false });    // final seg 1 (pinned), no ++
        asr.provider.emit('transcribing', { text: 'b', isPrimary: true });          // partial seg 2
        asr.provider.emit('transcribed', { text: 'b final', isPrimary: true });     // final seg 2, ++ -> 3
        asr.provider.emit('error', new Error('PROVIDER_BOOM'));                      // error-final seg 3, ++ -> 4
        asr.provider.emit('transcribed', { text: 'c final', isPrimary: true });     // final seg 4, ++ -> 5
        asr.provider.emit('transcribed', { text: 'c trans', isPrimary: false });    // final seg 4 (pinned)

        return recorded;
    }

    it('produces the GOLDEN sequence with no segmentAllocator (legacy bit-exact)', async () => {
        const recorded = await runSequence({});
        assert.deepStrictEqual(recorded, GOLDEN);
    });
});

module.exports = { GOLDEN };
