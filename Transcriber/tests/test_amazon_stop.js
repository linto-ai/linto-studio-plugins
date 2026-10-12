/**
 * AmazonTranscriber start()/stop() against a stub of the AWS Transcribe
 * streaming contract (no AWS credentials here: NOT validated against AWS).
 *
 * Contract reproduced by the stub, as documented for StartStreamTranscription
 * and implemented by the SDK (the event stream sends an end frame when the
 * AudioStream iterable completes):
 *   - the service reads the AudioStream iterable and emits partial results;
 *   - when the input ends, it emits the final results of the audio it got,
 *     then closes the TranscriptResultStream;
 *   - with no new audio and the input not ended for SILENCE_MS (15 s on AWS),
 *     the result stream fails with "no new audio was received for 15 seconds".
 *
 * The provider used to (a) resolve start() only when the result stream ended,
 * holding the ASR wrapper's transitions (stop flush, pause, dispose) chained
 * behind it until that silence timeout, and (b) emit the pending partial as a
 * final before the service's real final, which then came as a second caption.
 */

const assert = require('assert');
const { describe, it, before, after, beforeEach, afterEach } = require('mocha');
const { setupMocks, fromTranscriber } = require('./helpers/asr_mocks');

const SILENCE_MS = 1000; // stands for AWS's 15 s
const awsSdkPath = require.resolve('@aws-sdk/client-transcribe-streaming');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One StartStreamTranscription call of the stub service.
class StubStream {
    constructor(audioStream, { closesOnInputEnd = true } = {}) {
        this.chunks = [];
        this.inputEnded = false;
        this.events = [];
        this.waiters = [];
        this.closed = false;
        this.closesOnInputEnd = closesOnInputEnd;
        this.consume(audioStream);
    }

    push(event) {
        this.events.push(event);
        this.waiters.splice(0).forEach((wake) => wake());
    }

    result(text, isPartial) {
        return { TranscriptEvent: { Transcript: { Results: [{ IsPartial: isPartial, StartTime: 0, EndTime: 1, Alternatives: [{ Transcript: text }] }] } } };
    }

    async consume(audioStream) {
        let lastAudioAt = Date.now();
        const silence = setInterval(() => {
            if (!this.inputEnded && Date.now() - lastAudioAt > SILENCE_MS) {
                clearInterval(silence);
                const err = new Error('Your request timed out because no new audio was received for 15 seconds.');
                err.name = 'BadRequestException';
                this.push({ error: err });
            }
        }, 20);
        for await (const event of audioStream) {
            lastAudioAt = Date.now();
            this.chunks.push(event.AudioEvent.AudioChunk);
            this.push(this.result(`words ${this.chunks.length}`, true));
        }
        this.inputEnded = true;
        clearInterval(silence);
        if (!this.closesOnInputEnd) return; // a service that never answers
        await wait(30); // the service finalizes
        this.push(this.result(`words ${this.chunks.length}`, false));
        this.push({ end: true });
    }

    async *results() {
        for (;;) {
            while (this.events.length > 0) {
                const event = this.events.shift();
                if (event.end) { this.closed = true; return; }
                if (event.error) throw event.error;
                yield event;
            }
            await new Promise((resolve) => this.waiters.push(resolve));
        }
    }
}

const service = { streams: [], options: {} };

class StubTranscribeStreamingClient {
    constructor() { this.destroyed = false; }
    destroy() { this.destroyed = true; }
    async send(command) {
        const stream = new StubStream(command.input.AudioStream, service.options);
        service.streams.push(stream);
        return { TranscriptResultStream: stream.results() };
    }
}
class StubStartStreamTranscriptionCommand {
    constructor(input) { this.input = input; }
}

describe('AmazonTranscriber start/stop against the streaming contract (stub, not AWS)', () => {
    let teardown;
    let AmazonTranscriber;
    let ASR;
    let origAws;
    const ORIG_FLUSH = process.env.ASR_STOP_FLUSH_TIMEOUT_MS;
    const ORIG_SETTLE = process.env.ASR_STOP_SETTLE_MS;

    before(() => {
        process.env.ASR_STOP_FLUSH_TIMEOUT_MS = '3000';
        process.env.ASR_STOP_SETTLE_MS = '1';
        teardown = setupMocks({
            invalidate: [fromTranscriber('ASR/index.js'), fromTranscriber('ASR/amazon/index.js')],
            mockWs: false,
            circularBuffer: true,
        });
        origAws = require.cache[awsSdkPath];
        require.cache[awsSdkPath] = {
            id: awsSdkPath, filename: awsSdkPath, loaded: true,
            exports: {
                TranscribeStreamingClient: StubTranscribeStreamingClient,
                StartStreamTranscriptionCommand: StubStartStreamTranscriptionCommand,
            },
        };
        AmazonTranscriber = require('../ASR/amazon/index.js');
        AmazonTranscriber.prototype.getCredentialsFromHelper = async () => ({ accessKeyId: 'a', secretAccessKey: 'b', sessionToken: 'c' });
        ASR = require('../ASR/index.js');
    });

    after(() => {
        if (origAws) require.cache[awsSdkPath] = origAws; else delete require.cache[awsSdkPath];
        if (teardown) teardown();
        if (ORIG_FLUSH === undefined) delete process.env.ASR_STOP_FLUSH_TIMEOUT_MS; else process.env.ASR_STOP_FLUSH_TIMEOUT_MS = ORIG_FLUSH;
        if (ORIG_SETTLE === undefined) delete process.env.ASR_STOP_SETTLE_MS; else process.env.ASR_STOP_SETTLE_MS = ORIG_SETTLE;
    });

    beforeEach(() => {
        service.streams = [];
        service.options = {};
    });

    const channel = {
        id: 'c',
        enableLiveTranscripts: true,
        keepAudio: false,
        translations: [],
        transcriberProfile: { config: { type: 'amazon', region: 'eu-west-1', languages: [{ candidate: 'fr-FR' }] } },
    };

    async function streaming() {
        const provider = new AmazonTranscriber({ id: 's' }, channel);
        const finals = [];
        provider.on('transcribed', (t) => finals.push(t.text));
        const started = provider.start();
        await wait(20);
        return { provider, finals, started };
    }

    it('start() resolves once the stream is up, not when it ends', async () => {
        const { started } = await streaming();
        const outcome = await Promise.race([started.then(() => 'resolved'), wait(200).then(() => 'pending')]);
        assert.strictEqual(outcome, 'resolved');
    });

    it('stop() ends the input: the service\'s final arrives once, and stop() returns promptly', async () => {
        const { provider, finals } = await streaming();
        provider.transcribe(Buffer.from([1, 2]));
        provider.transcribe(Buffer.from([3, 4]));
        await wait(50); // partials received
        const startedAt = Date.now();
        await provider.stop();
        const stream = service.streams[0];
        assert.ok(stream.inputEnded, 'the audio iterable completed (end-of-stream frame)');
        assert.ok(stream.closed, 'the result stream was closed by the service');
        assert.deepStrictEqual(finals, ['words 2'], 'the service\'s final, not the partial as well');
        assert.ok(Date.now() - startedAt < SILENCE_MS / 2, `stop() took ${Date.now() - startedAt} ms`);
    });

    it('sends the audio still queued before ending the input', async () => {
        const { provider } = await streaming();
        provider.transcribe(Buffer.from([1, 2]));
        provider.transcribe(Buffer.from([3, 4]));
        await provider.stop(); // right away: both chunks still queued
        assert.deepStrictEqual(service.streams[0].chunks.map((c) => [...c]), [[1, 2], [3, 4]]);
    });

    it('stop() is bounded when the service never closes, and keeps the last partial as a final', async () => {
        process.env.ASR_STOP_FLUSH_TIMEOUT_MS = '700'; // waits 700 - 500 ms
        service.options = { closesOnInputEnd: false };
        try {
            const { provider, finals } = await streaming();
            provider.transcribe(Buffer.from([1, 2]));
            await wait(50);
            const startedAt = Date.now();
            await provider.stop();
            const took = Date.now() - startedAt;
            assert.ok(took >= 190 && took < 600, `stop() took ${took} ms`);
            assert.deepStrictEqual(finals, ['words 1']);
        } finally {
            process.env.ASR_STOP_FLUSH_TIMEOUT_MS = '3000';
        }
    });

    it('a restart after stop() (pause, resume) streams the new audio to the new stream only', async () => {
        const { provider } = await streaming();
        provider.transcribe(Buffer.from([1, 2]));
        await provider.stop();
        provider.start();
        await wait(20);
        provider.transcribe(Buffer.from([9, 9]));
        await wait(50);
        assert.strictEqual(service.streams.length, 2);
        assert.deepStrictEqual(service.streams[0].chunks.map((c) => [...c]), [[1, 2]]);
        assert.deepStrictEqual(service.streams[1].chunks.map((c) => [...c]), [[9, 9]]);
        await provider.stop();
    });

    it('under the ASR wrapper, the stop flush is not held until the silence timeout', async () => {
        const asr = new ASR({ id: 's' }, channel);
        const finals = [];
        asr.on('final', (t) => finals.push(t));
        await wait(20); // init(): provider started
        asr.provider.transcribe(Buffer.from([1, 2]));
        await wait(50);
        const startedAt = Date.now();
        await asr.flushFinals();
        const took = Date.now() - startedAt;
        assert.ok(took < SILENCE_MS / 2, `flushFinals() took ${took} ms`);
        assert.deepStrictEqual(finals.map((f) => f.text), ['words 1'], 'the last final, published before the flush returns');
        await asr.dispose();
    });
});
