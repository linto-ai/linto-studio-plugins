/**
 * StreamingServer stop sequence vs. a client that reconnects at once.
 *
 * Stopping a stream flushes its ASR before the channel deactivation is
 * published (StreamingServer._stopAsr). A client that reconnects right away
 * (e.g. a bot reopening its WS to switch diarization mode) starts a newer
 * stream on the same channel during that flush, and its activation goes out
 * first. The old stream's deactivation carries the same transcriberId, so the
 * Scheduler would mark the channel inactive while the newer stream runs:
 * wrong status, and the session-end drain would no longer wait for that
 * stream's last captions. The old stream still publishes its finals and its
 * end-of-stream marker, but not the deactivation.
 *
 * Drives the real StreamingServer, WebsocketServer (no socket opened) and ASR
 * wrapper with the FakeTranscriber provider (enableLiveTranscripts:false).
 */

const assert = require('assert');
const EventEmitter = require('eventemitter3');
const { describe, it, before, after, beforeEach } = require('mocha');
const { setupMocks, fromTranscriber } = require('./helpers/asr_mocks');

const STREAMING_SERVER = fromTranscriber('components/StreamingServer/index.js');

// Stand-in for live-srt-lib's Component: no controllers loaded from disk.
class FakeComponent extends EventEmitter {
    constructor(app) {
        super();
        this.app = app;
    }
    async init() {}
}

describe('StreamingServer stop flush vs. an immediate reconnect', () => {
    let teardown;
    let createStreamingServer;
    const ORIG_ENV = {};
    const ENV = { STREAMING_PROTOCOLS: 'WS', ASR_STOP_SETTLE_MS: '40', TRANSCRIBER_BOT_NAME: 'bot' };

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
    const channel = { id: 7, enableLiveTranscripts: false, keepAudio: false, translations: [] };
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    let streaming, ws, events;
    beforeEach(async () => {
        streaming = createStreamingServer({ components: {} });
        await wait(0); // init() then initialize() create the WS server
        ws = streaming.servers[0];
        events = [];
        streaming.on('session-start', () => events.push('active'));
        streaming.on('session-stop', () => events.push('inactive'));
        streaming.on('final', (t) => events.push(t.locutor === 'bot' && t.aend ? 'marker' : `final ${t.text}`));
    });

    it('publishes the deactivation after the flush when the stream simply stops', async () => {
        ws.emit('session-start', session, channel);
        ws.emit('session-stop', session, channel.id);
        await wait(100);
        assert.deepStrictEqual(events, ['active', 'marker', 'inactive']);
        assert.strictEqual(streaming.ASRs.size, 0);
    });

    it('keeps the channel active when a newer stream starts during the flush', async () => {
        ws.emit('session-start', session, channel);
        const first = streaming.ASRs.get('sess_7');
        ws.emit('session-stop', session, channel.id);   // stream A ends: flush in progress
        ws.emit('session-start', session, channel);     // stream B reconnects at once
        const second = streaming.ASRs.get('sess_7');
        assert.notStrictEqual(second, first);
        await wait(100);
        assert.deepStrictEqual(events, ['active', 'active', 'marker'],
            "A's marker is published, but not A's deactivation");
        assert.strictEqual(streaming.ASRs.get('sess_7'), second, 'B keeps running');

        ws.emit('session-stop', session, channel.id);   // stream B ends
        await wait(100);
        assert.deepStrictEqual(events.slice(3), ['marker', 'inactive'], "B's stop deactivates the channel");
    });

    it('deactivates once, after the newer stream\'s last caption, when that stream is stopped too', async () => {
        ws.emit('session-start', session, channel);
        ws.emit('session-stop', session, channel.id);
        ws.emit('session-start', session, channel);
        ws.emit('session-stop', session, channel.id); // the newer stream is being stopped as well
        await wait(150);
        // A deactivation before the newer stream's marker would let a
        // session-end drain finish before that stream's captions are stored.
        assert.deepStrictEqual(events, ['active', 'active', 'marker', 'marker', 'inactive']);
        assert.strictEqual(streaming.ASRs.size, 0);
        assert.strictEqual(streaming.latestStreams.size, 0, 'no channel entry left behind');
    });
});
