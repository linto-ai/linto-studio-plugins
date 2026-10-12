/**
 * Segment-id continuity across reconnects.
 *
 * Studio merges closed captions by segmentId, so two segments of a channel must
 * never share an id. A new stream on a channel resolves its first id from:
 *   - the cursor of a stream this instance stopped (StreamingServer.lastSegmentIds),
 *   - the channel's lastSegmentId in the statuses snapshot (stored by the
 *     Scheduler; the only source when the previous stream ran on another
 *     instance, see doc/production-topology.md).
 * A client that reconnects at once to the same instance starts the new stream
 * while the previous one is still flushing its ASR, which can still publish a
 * final: the stream being stopped keeps a reserve of ids and the new one starts
 * right after it, at once, not from the snapshot (stale: it is not republished
 * on every caption).
 *
 * Drives the real StreamingServer, WebsocketServer (no socket opened) and ASR
 * wrapper with the FakeTranscriber provider (enableLiveTranscripts:false).
 */

const assert = require('assert');
const EventEmitter = require('eventemitter3');
const { describe, it, before, after, beforeEach } = require('mocha');
const { setupMocks, fromTranscriber } = require('./helpers/asr_mocks');

const STREAMING_SERVER = fromTranscriber('components/StreamingServer/index.js');

class FakeComponent extends EventEmitter {
    constructor(app) {
        super();
        this.app = app;
    }
    async init() {}
}

describe('Segment-id continuity across reconnects', () => {
    let teardown;
    let createStreamingServer;
    const ORIG_ENV = {};
    // MIN_AUDIO_BUFFER 1000 ms at SAMPLE_RATE=1 / BYTES_PER_SAMPLE=1 (tests.js):
    // the ASR sends its buffer to the provider from 1 byte on.
    const ENV = { STREAMING_PROTOCOLS: 'WS', ASR_STOP_SETTLE_MS: '40', TRANSCRIBER_BOT_NAME: 'bot', MIN_AUDIO_BUFFER: '1000' };

    before(() => {
        for (const [k, v] of Object.entries(ENV)) {
            ORIG_ENV[k] = process.env[k];
            process.env[k] = v;
        }
        teardown = setupMocks({
            invalidate: [fromTranscriber('ASR/index.js'), fromTranscriber('ASR/fake/index.js'), STREAMING_SERVER],
            mockWs: false,
            circularBuffer: true,
        });
        require.cache[require.resolve('live-srt-lib')].exports.Component = FakeComponent;
        createStreamingServer = require(STREAMING_SERVER);
    });

    after(() => {
        if (teardown) teardown();
        for (const [k, v] of Object.entries(ORIG_ENV)) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
    });

    const session = { id: 'sess' };
    const KEY = 'sess_7';
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const channelWith = (lastSegmentId) => ({
        id: 7, enableLiveTranscripts: false, keepAudio: false, translations: [], lastSegmentId,
    });

    async function instance() {
        const streaming = createStreamingServer({ components: {} });
        await wait(0); // init() then initialize() create the WS server
        const finals = [];
        streaming.on('final', (t) => { if (t.segmentId !== undefined) finals.push({ id: t.segmentId, text: t.text }); });
        return { streaming, ws: streaming.servers[0], finals };
    }

    async function startStream(ws, streaming, channel) {
        ws.emit('session-start', session, channel);
        const asr = streaming.ASRs.get(KEY);
        await asr._transitionLock; // provider started
        return asr;
    }

    describe('same instance, immediate reconnect', () => {
        let streaming, ws, finals;
        beforeEach(async () => ({ streaming, ws, finals } = await instance()));

        // The stop flush of the first stream returns these finals, as Azure does.
        function flushReturns(asr, texts) {
            asr.provider.stop = function () {
                this.stopCount += 1;
                for (const text of texts) this.emit('transcribed', { text, astart: 0, locutor: 'test' });
                this.emit('closed');
            };
        }

        it('starts the new stream at once, after the ids reserved for the stream being stopped', async () => {
            // The snapshot was taken at activation: no caption stored yet.
            const channel = channelWith(0);
            const first = await startStream(ws, streaming, channel);
            for (const text of ['one', 'two', 'three']) first.provider.simulateFinal({ text, astart: 0 });
            flushReturns(first, ['flushed at stop']);

            ws.emit('session-stop', session, channel.id); // flush in progress
            ws.emit('session-start', session, channel);   // the client reconnects at once
            const second = streaming.ASRs.get(KEY);
            await second._transitionLock;
            assert.ok(second.provider, 'the new provider starts at once');
            assert.strictEqual(second.segmentId, 14, 'after the 10 ids reserved from segment 4');
            second.provider.simulateFinal({ text: 'after reconnect', astart: 0 });

            await wait(100);
            assert.deepStrictEqual(finals, [
                { id: 1, text: 'one' }, { id: 2, text: 'two' }, { id: 3, text: 'three' },
                { id: 4, text: 'flushed at stop' }, // within the first stream's reserve
                { id: 14, text: 'after reconnect' },
            ]);
        });

        it('never reuses an id, even when the stream being stopped runs out of reserved ids', async () => {
            const channel = channelWith(0);
            const first = await startStream(ws, streaming, channel);
            flushReturns(first, Array.from({ length: 12 }, (_, i) => `late ${i + 1}`));
            ws.emit('session-stop', session, channel.id);
            ws.emit('session-start', session, channel);
            const second = streaming.ASRs.get(KEY);
            await second._transitionLock;
            second.provider.simulateFinal({ text: 'after reconnect', astart: 0 });
            await wait(100);
            const ids = finals.map((f) => f.id);
            assert.deepStrictEqual(finals.find((f) => f.text === 'after reconnect'), { id: 11, text: 'after reconnect' });
            assert.deepStrictEqual(finals.filter((f) => f.text.startsWith('late')).map((f) => f.id),
                [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'the 10 reserved ids, the last 2 finals dropped');
            assert.strictEqual(new Set(ids).size, ids.length, `no id used twice: ${ids}`);
        });

        it('feeds the new stream\'s audio to its provider at once, none lost', async () => {
            const channel = channelWith(0);
            await startStream(ws, streaming, channel);
            ws.emit('session-stop', session, channel.id);
            ws.emit('session-start', session, channel);
            // Same tick as the start (ws emits the frames of one socket read at
            // once): before the ASR's init() ran, so buffered.
            ws.emit('data', Buffer.from([1, 2]), session.id, channel.id);
            const second = streaming.ASRs.get(KEY);
            await wait(0); // init() ran; the previous stream is still flushing (40 ms settle)
            assert.ok(second.provider, 'the new provider is up while the previous stream stops');
            ws.emit('data', Buffer.from([3, 4]), session.id, channel.id);
            assert.strictEqual(second.provider.byteCount, 4, 'no hold while the previous stream stops');
        });

        it('gives back the unused reserved ids when no newer stream started meanwhile', async () => {
            const channel = channelWith(0);
            const first = await startStream(ws, streaming, channel);
            first.provider.simulateFinal({ text: 'one', astart: 0 });
            ws.emit('session-stop', session, channel.id);
            await wait(100);
            const second = await startStream(ws, streaming, channel);
            assert.strictEqual(second.segmentId, 3, 'right after the in-progress segment 2, no gap');
        });

        it('chains successive immediate reconnects without waiting', async () => {
            const channel = channelWith(0);
            const first = await startStream(ws, streaming, channel);
            first.provider.simulateFinal({ text: 'one', astart: 0 });
            ws.emit('session-stop', session, channel.id);
            ws.emit('session-start', session, channel); // second stream...
            ws.emit('session-stop', session, channel.id); // ...dropped at once
            ws.emit('session-start', session, channel); // third stream
            const third = streaming.ASRs.get(KEY);
            await third._transitionLock;
            assert.ok(third.provider, 'started at once');
            third.provider.simulateFinal({ text: 'three', astart: 0 });
            await wait(100);
            assert.deepStrictEqual(finals.map((f) => f.id), [1, 22],
                'after the reserves of the first (2-11) and second (12-21) streams');
        });
    });

    describe('cross-instance reconnect (snapshot lastSegmentId)', () => {
        it('starts after the stored last id when the previous stream ran on another instance', async () => {
            const { streaming, ws, finals } = await instance();
            const asr = await startStream(ws, streaming, channelWith(41));
            assert.strictEqual(asr.segmentId, 42, 'no wait: nothing is stopping on this instance');
            asr.provider.simulateFinal({ text: 'resumed', astart: 0 });
            assert.deepStrictEqual(finals, [{ id: 42, text: 'resumed' }]);
        });

        it('prefers the snapshot over an older local cursor (streamed elsewhere since)', async () => {
            const { streaming, ws } = await instance();
            streaming.lastSegmentIds.set(KEY, 6); // a stream this instance stopped earlier
            const asr = await startStream(ws, streaming, channelWith(41));
            assert.strictEqual(asr.segmentId, 42);
        });

        it('prefers the local cursor over an older snapshot (same instance)', async () => {
            const { streaming, ws } = await instance();
            streaming.lastSegmentIds.set(KEY, 50);
            const asr = await startStream(ws, streaming, channelWith(10));
            assert.strictEqual(asr.segmentId, 50);
        });

        it('restarts from 1 after the captions were cleared', async () => {
            const { streaming, ws } = await instance();
            streaming.lastSegmentIds.set(KEY, 50);
            streaming.clearSession('sess', [7]);
            const asr = await startStream(ws, streaming, channelWith(0));
            assert.strictEqual(asr.segmentId, 1);
        });
    });
});
