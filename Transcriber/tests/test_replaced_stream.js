/**
 * A connection replaced by a newer one on the same channel (same Transcriber).
 *
 * The streaming servers clean the old connection up when the newer one is
 * accepted, then again when the old socket finally closes (close handshake,
 * TCP timeout), when its GStreamer worker exits, or when a read on it fails.
 * That late cleanup used to emit 'session-stop' for the channel and delete the
 * channel's entries: it stopped the NEWER stream's ASR (deactivating the
 * channel) and dropped its running entry and SpeakerTracker. Cleanup is now
 * scoped to the stream it belongs to.
 *
 * Drives the real StreamingServer, WebsocketServer and ASR wrapper (FakeTranscriber).
 */

const assert = require('assert');
const childProcess = require('child_process');
const EventEmitter = require('eventemitter3');
const { describe, it, before, after, beforeEach } = require('mocha');
const { setupMocks, fromTranscriber } = require('./helpers/asr_mocks');

const STREAMING_SERVER = fromTranscriber('components/StreamingServer/index.js');
const WEBSOCKET_SERVER = fromTranscriber('components/StreamingServer/websocket/WebsocketServer.js');
const SRT_SERVER = fromTranscriber('components/StreamingServer/srt/SRTServer.js');

class FakeComponent extends EventEmitter {
    constructor(app) {
        super();
        this.app = app;
    }
    async init() {}
}

class FakeWs extends EventEmitter {
    send() {}
    close() { this.closed = true; }
}

// Stands for a forked GStreamerWorker (non-PCM WS path).
class FakeWorker extends EventEmitter {
    constructor() { super(); this.connected = true; this.pid = 4242; }
    send() {}
    kill() { this.killed = true; }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('A replaced connection cleaned up late', () => {
    let teardown;
    let createStreamingServer;
    let origFork;
    let workers;
    const ORIG_ENV = {};
    const ENV = { STREAMING_PROTOCOLS: 'WS', ASR_STOP_SETTLE_MS: '20', ASR_STOP_FLUSH_TIMEOUT_MS: '50', TRANSCRIBER_BOT_NAME: 'bot' };

    before(() => {
        for (const [k, v] of Object.entries(ENV)) {
            ORIG_ENV[k] = process.env[k];
            process.env[k] = v;
        }
        // WebsocketServer destructures fork at load: patch it before requiring.
        origFork = childProcess.fork;
        childProcess.fork = () => {
            const worker = new FakeWorker();
            workers.push(worker);
            return worker;
        };
        teardown = setupMocks({
            invalidate: [fromTranscriber('ASR/index.js'), fromTranscriber('ASR/fake/index.js'), STREAMING_SERVER, WEBSOCKET_SERVER],
            mockWs: false,
            circularBuffer: true,
        });
        require.cache[require.resolve('live-srt-lib')].exports.Component = FakeComponent;
        createStreamingServer = require(STREAMING_SERVER);
    });

    after(() => {
        childProcess.fork = origFork;
        if (teardown) teardown();
        for (const [k, v] of Object.entries(ORIG_ENV)) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
    });

    const KEY = 'sess_7';
    let streaming, server, events;
    beforeEach(async () => {
        workers = [];
        streaming = createStreamingServer({ components: {} });
        await wait(0);
        server = streaming.servers[0];
        // Streams are addressed by the session's private id, never the public one.
        server.setSessions([{ id: 'sess', privateId: 'priv-sess', channels: [{ id: 7, enableLiveTranscripts: false, keepAudio: false, translations: [], lastSegmentId: 0, streamStatus: 'inactive' }] }]);
        events = [];
        streaming.on('session-start', () => events.push('active'));
        streaming.on('session-stop', () => events.push('inactive'));
    });

    async function connect(encoding) {
        const ws = new FakeWs();
        await server.onConnection(ws, { url: '/priv-sess,0' });
        ws.emit('message', Buffer.from(JSON.stringify({ type: 'init', encoding, sampleRate: 16000, diarizationMode: 'native' })), false);
        return ws;
    }

    it('PCM path: the old socket\'s late close leaves the newer stream running', async () => {
        const a = await connect('pcm');
        const asrA = streaming.ASRs.get(KEY);
        const b = await connect('pcm'); // replaces A
        const asrB = streaming.ASRs.get(KEY);
        const trackerB = server.getSpeakerTracker('sess', 7);
        await wait(150); // A's stop done
        assert.notStrictEqual(asrB, asrA);

        a.emit('close'); // A's socket closes at last
        await wait(150);

        assert.strictEqual(streaming.ASRs.get(KEY), asrB, 'B\'s ASR still serves the channel');
        assert.strictEqual(server.runningChannels[7].ws, b, 'B is still the running connection');
        assert.strictEqual(server.getSpeakerTracker('sess', 7), trackerB, 'B\'s tracker kept');
        assert.strictEqual(server.runningSessions.sess.length, 1);
        assert.ok(!b.closed, 'B\'s socket left open');
        assert.deepStrictEqual(events, ['active', 'active'], 'no deactivation: B holds the channel');
    });

    it('PCM path: frames still arriving on the old socket do not reach the newer stream', async () => {
        const a = await connect('pcm');
        await connect('pcm'); // replaces A
        const asrB = streaming.ASRs.get(KEY);
        await asrB._transitionLock;
        a.emit('message', Buffer.from([1, 2, 3, 4]), true);
        assert.strictEqual(asrB.provider.byteCount, 0);
    });

    it('worker path: the old worker\'s late exit leaves the newer stream running', async () => {
        await connect('webm');
        const workerA = workers[0];
        const b = await connect('webm'); // replaces A
        const asrB = streaming.ASRs.get(KEY);
        await wait(150);

        workerA.emit('exit', 0, null); // A's GStreamer worker exits at last
        workerA.emit('message', { type: 'data', buf: Buffer.from([1, 2]) }); // a late frame from it
        await wait(150);

        assert.strictEqual(streaming.ASRs.get(KEY), asrB);
        assert.strictEqual(server.runningChannels[7].ws, b);
        assert.ok(!workers[1].killed, 'B\'s worker left alone');
        assert.strictEqual(asrB.provider.byteCount, 0, 'A\'s late frame not fed to B');
        assert.deepStrictEqual(events, ['active', 'active']);
    });

    it('still deactivates the channel when its current stream closes', async () => {
        await connect('pcm');
        const b = await connect('pcm');
        await wait(150);
        b.emit('close');
        await wait(150);
        assert.strictEqual(streaming.ASRs.has(KEY), false);
        assert.strictEqual(server.runningChannels[7], undefined);
        assert.deepStrictEqual(events, ['active', 'active', 'inactive']);
    });

    it('StreamingServer ignores the stop of a stream its channel\'s ASR does not serve', async () => {
        const ws = streaming.servers[0];
        const older = {};
        const newer = {};
        ws.emit('session-start', { id: 'sess' }, { id: 7, enableLiveTranscripts: false, translations: [] }, newer);
        const asr = streaming.ASRs.get(KEY);
        assert.strictEqual(await streaming._stopAsr({ id: 'sess' }, 7, older), false);
        assert.strictEqual(streaming.ASRs.get(KEY), asr);
        assert.strictEqual(await streaming._stopAsr({ id: 'sess' }, 7, newer), true);
    });
});

describe('SRT: a replaced connection cleaned up again', () => {
    let SRTServer;
    let teardown;
    before(() => {
        teardown = setupMocks({ invalidate: [SRT_SERVER], mockWs: false });
        SRTServer = require(SRT_SERVER);
    });
    after(() => { if (teardown) teardown(); });

    // cleanupConnection on a bare server state (the constructor opens SRT resources).
    function serverState() {
        const state = new EventEmitter();
        Object.assign(state, {
            workers: [], runningSessions: {}, runningChannels: {}, getLogMeta: () => ({}),
            cleanedConnections: new Set(), connectionHandlers: new Map(),
        });
        state.stops = [];
        state.on('session-stop', (session, channelId, stream) => state.stops.push(stream));
        return state;
    }
    const connection = () => ({ fd: 1, removeAllListeners() {}, close() {} });
    const worker = () => ({ removeAllListeners() {}, kill() {} });

    it('stops the old stream once and keeps the newer one\'s entries', () => {
        const state = serverState();
        const session = { id: 'sess' };
        const fdA = { session, channel: { id: 7 } };
        const fdB = { session, channel: { id: 7 } };
        const a = { connection: connection(), fd: fdA, worker: worker() };
        state.runningSessions.sess = [a];
        state.runningChannels[7] = a;
        SRTServer.prototype.cleanupConnection.call(state, a.connection, fdA, a.worker); // replaced
        const b = { connection: connection(), fd: fdB, worker: worker() };
        state.runningSessions.sess = [b];
        state.runningChannels[7] = b;

        SRTServer.prototype.cleanupConnection.call(state, a.connection, fdA, a.worker); // a late read error on A

        assert.deepStrictEqual(state.stops, [fdA], 'one stop, for A');
        assert.strictEqual(state.runningChannels[7], b);
        assert.deepStrictEqual(state.runningSessions.sess, [b]);
    });
});
