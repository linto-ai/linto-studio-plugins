/**
 * ASR providers emit finals with empty text: Azure recognizes silence or noise
 * as RecognizedSpeech "" roughly every 7-8 s while a meeting is silent, and its
 * stop flush can return one too (the provider debug-logs each of them as
 * "final transcription: "). The ASR wrapper must drop them, so they are never
 * published on .../final, never stored as captions (empty turns in Studio
 * conversations) and never consume a segmentId. The only text-less final is
 * the end-of-stream marker (locutor TRANSCRIBER_BOT_NAME, aend).
 *
 * Same require-cache injection as test_asr_flush_finals.js: a channel with
 * enableLiveTranscripts:false forces the pilotable FakeTranscriber as provider.
 */

const assert = require('assert');
const { describe, it, before, after } = require('mocha');
const { setupMocks, fromTranscriber } = require('./helpers/asr_mocks');

const ASR_MOCK_OPTS = {
    invalidate: [fromTranscriber('ASR/index.js'), fromTranscriber('ASR/fake/index.js')],
    mockWs: false,
    circularBuffer: true,
};

describe('ASR empty finals', () => {
    let ASR;
    let teardown;
    const ORIG_SETTLE = process.env.ASR_STOP_SETTLE_MS;
    const ORIG_BOT_NAME = process.env.TRANSCRIBER_BOT_NAME;

    before(() => {
        process.env.ASR_STOP_SETTLE_MS = '1';
        process.env.TRANSCRIBER_BOT_NAME = 'bot';
        teardown = setupMocks(ASR_MOCK_OPTS);
        ASR = require('../ASR/index.js');
    });

    after(() => {
        if (teardown) teardown();
        if (ORIG_SETTLE === undefined) delete process.env.ASR_STOP_SETTLE_MS; else process.env.ASR_STOP_SETTLE_MS = ORIG_SETTLE;
        if (ORIG_BOT_NAME === undefined) delete process.env.TRANSCRIBER_BOT_NAME; else process.env.TRANSCRIBER_BOT_NAME = ORIG_BOT_NAME;
    });

    async function makeReadyAsr() {
        const asr = new ASR({ id: 'test-session-id' }, {
            id: 'test-channel-id',
            enableLiveTranscripts: false, // -> FakeTranscriber provider
            keepAudio: false,
            transcriberProfile: { config: { type: 'fake', languages: [] } },
            translations: [],
        });
        await new Promise((r) => setImmediate(r));
        await asr._transitionLock;
        return asr;
    }

    it('drops empty and whitespace-only finals without consuming a segmentId', async () => {
        const asr = await makeReadyAsr();
        const finals = [];
        asr.on('final', (f) => finals.push(f));
        const segmentId = asr.segmentId;

        for (const text of ['', ' ', '\n\t ']) {
            asr.provider.simulateFinal({ text, astart: 0 });
        }
        assert.deepStrictEqual(finals, [], 'no empty final emitted');
        assert.strictEqual(asr.segmentId, segmentId, 'segmentId not consumed');

        asr.provider.simulateFinal({ text: 'hello', astart: 0 });
        assert.strictEqual(finals.length, 1);
        assert.strictEqual(finals[0].segmentId, segmentId, 'the next real final keeps the sequence gap-free');
    });

    it('drops an empty final flushed at stream stop; only the end-of-stream marker follows', async () => {
        const asr = await makeReadyAsr();
        const finals = [];
        asr.on('final', (f) => finals.push(f));
        asr.provider.stop = function () {
            this.stopCount += 1;
            this.emit('transcribed', { text: '', astart: 0, locutor: 'spk' });
            this.emit('closed');
        };

        await asr.flushFinals();
        asr.streamStopped();

        assert.strictEqual(finals.length, 1, JSON.stringify(finals));
        assert.strictEqual(finals[0].text, '');
        assert.strictEqual(finals[0].locutor, 'bot');
        assert.ok(finals[0].aend, 'the marker carries aend');
        assert.strictEqual(finals[0].segmentId, undefined, 'the marker has no segmentId');
    });
});
