/**
 * ASR.transcribe() hands the accumulated audio to the provider and to the
 * kept-audio file, then reuses its circular buffer for the next packets. Both
 * consumers may hold on to the chunk after transcribe() returns (Amazon queues
 * it, a write stream writes it later), so they must get a copy: a view of the
 * circular buffer would be overwritten by the next packet.
 *
 * Same require-cache injection as test_asr_flush_finals.js: a channel with
 * enableLiveTranscripts:false forces the pilotable FakeTranscriber as provider.
 */

const assert = require('assert');
const { describe, it, before, after } = require('mocha');
const { setupMocks, fromTranscriber } = require('./helpers/asr_mocks');

describe('ASR.transcribe() audio handed to its consumers', () => {
    let ASR;
    let teardown;
    const ORIG_MIN = process.env.MIN_AUDIO_BUFFER;

    before(() => {
        // 1000 ms at SAMPLE_RATE=1 / BYTES_PER_SAMPLE=1 (tests.js): every packet is sent.
        process.env.MIN_AUDIO_BUFFER = '1000';
        teardown = setupMocks({
            invalidate: [fromTranscriber('ASR/index.js'), fromTranscriber('ASR/fake/index.js')],
            mockWs: false,
            circularBuffer: true,
        });
        ASR = require('../ASR/index.js');
    });

    after(() => {
        if (teardown) teardown();
        if (ORIG_MIN === undefined) delete process.env.MIN_AUDIO_BUFFER; else process.env.MIN_AUDIO_BUFFER = ORIG_MIN;
    });

    it('gives the provider and the kept-audio file chunks that later packets cannot overwrite', async () => {
        const asr = new ASR({ id: 's' }, {
            id: 'c',
            enableLiveTranscripts: false, // -> FakeTranscriber provider
            keepAudio: false,
            transcriberProfile: { config: { type: 'fake', languages: [] } },
            translations: [],
        });
        await asr._transitionLock;
        const sent = [];
        const written = [];
        asr.provider.transcribe = (chunk) => sent.push(chunk);
        // Kept audio: a write stream that, like fs.WriteStream, keeps the chunk.
        asr.channel.keepAudio = true;
        asr.audioFile = { write: (chunk) => written.push(chunk) };

        asr.transcribe(Buffer.from([1, 2]));
        asr.transcribe(Buffer.from([3, 4]));

        assert.deepStrictEqual(sent.map((c) => [...c]), [[1, 2], [3, 4]]);
        assert.deepStrictEqual(written.map((c) => [...c]), [[1, 2], [3, 4]]);
    });
});
