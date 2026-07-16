/**
 * SRT wedge detection (see SRT-WEDGE-RCA.md).
 *
 * A wedged SRT socket keeps waking the read loop while delivering zero payload:
 * libsrt's TSBPD delivery clock gets displaced far into the future, it accepts
 * packets and delivers none, forever, on that one socket. The 5 s sentinel used to
 * measure the epoll wakeup, so it stayed green through 58 min of silence.
 *
 * These tests exercise the REAL SRTServer.js with linto-node-srt stubbed in
 * require.cache (the native addon only builds in Docker), and drive
 * checkTimedOutChannel() directly rather than waiting on its 1 s interval.
 */
const assert = require('assert');
const path = require('path');
const EventEmitter = require('events');
const { describe, it, before, after, beforeEach } = require('mocha');

const srtLibPath = require.resolve('linto-node-srt', { paths: [path.join(__dirname, '..')] });
const srtServerPath = path.join(__dirname, '../components/StreamingServer/srt/SRTServer.js');

// Mirrors node-srt's SRTConnection: close() emits 'closing' then 'closed', and is
// idempotent. The server registers its own 'closing' listener to evict the fd from
// _connectionMap — the reason cleanup must not removeAllListeners().
class FakeConnection extends EventEmitter {
    constructor(fd) {
        super();
        this._fd = fd;
        this.closeCount = 0;
    }
    get fd() { return this._fd; }
    async close() {
        if (this.closeCount++ > 0) return null;
        this.emit('closing');
        this.emit('closed');
        return 0;
    }
}

// readChunks only resolves once it has accumulated minBytesRead, so a starved socket
// never returns from it — onRead firing per chunk is the only usable payload signal.
const healthyReaderWriter = () => ({
    readChunks: async (min, bufSize, onRead) => {
        const buf = Buffer.alloc(1316);
        if (onRead) onRead(buf);
        return [buf];
    },
});
const wedgedReaderWriter = () => ({
    readChunks: () => new Promise(() => {}), // never resolves, never calls onRead
});

describe('SRT payload-stall detection', () => {
    let MultiplexedSRTServer, srtLibCache, srtServerCache;

    before(() => {
        srtLibCache = require.cache[srtLibPath];
        srtServerCache = require.cache[srtServerPath];
        require.cache[srtLibPath] = {
            id: srtLibPath, filename: srtLibPath, loaded: true,
            exports: { SRT: {}, AsyncSRT: class { async getSockOpt() { return ''; } }, SRTServer: class {} },
        };
        delete require.cache[srtServerPath];
        MultiplexedSRTServer = require(srtServerPath);
    });

    after(() => {
        if (srtLibCache) require.cache[srtLibPath] = srtLibCache; else delete require.cache[srtLibPath];
        if (srtServerCache) require.cache[srtServerPath] = srtServerCache; else delete require.cache[srtServerPath];
    });

    let server, connection, fd, worker, stops, connectionMap;

    // Wires one running channel the way onConnection would, minus the forked worker.
    const wireChannel = (readerWriter) => {
        server = new MultiplexedSRTServer({});
        clearInterval(server.checkInterval);
        stops = [];
        server.on('session-stop', (session, channelId) => stops.push(channelId));

        connection = new FakeConnection(42);
        fd = { session: { id: 'sess-1', name: 's' }, channel: { id: 'ch-4' } };
        worker = Object.assign(new EventEmitter(), { pid: 1, connected: true, send() {}, kill() {} });

        // node-srt's own listener, registered by SRTServer before handing us the connection
        connectionMap = { 42: connection };
        connection.on('closing', () => { delete connectionMap[42]; });

        server.addRunningSession(fd.session, connection, fd, worker);
        server.handleConnectionEvents(connection, fd, worker, readerWriter);
        return server.runningChannels['ch-4'];
    };

    const tick = () => new Promise(r => setImmediate(r));

    it('does not bump the payload clock on a socket wakeup that delivers nothing', async () => {
        const channel = wireChannel(wedgedReaderWriter());
        const stale = Date.now() - 60_000;
        channel.lastEvent = stale;
        channel.lastPayload = stale;

        for (let i = 0; i < 5; i++) connection.emit('data');
        await tick();

        assert.ok(channel.lastEvent > stale, 'lastEvent should track socket wakeups');
        assert.strictEqual(channel.lastPayload, stale, 'lastPayload must not move without bytes read');
    });

    it('bumps the payload clock on bytes actually read', async () => {
        const channel = wireChannel(healthyReaderWriter());
        const stale = Date.now() - 60_000;
        channel.lastPayload = stale;

        connection.emit('data');
        await tick();

        assert.ok(channel.lastPayload > stale, 'lastPayload should track bytes delivered');
    });

    it('tears down an event-fresh but payload-stale channel (the wedge signature)', async () => {
        const channel = wireChannel(wedgedReaderWriter());
        const now = Date.now();
        channel.lastEvent = now;                                                  // socket still signalling
        channel.lastPayload = now - (server.payloadTimeoutSeconds * 1000 + 1000); // no audio

        server.checkTimedOutChannel();

        assert.deepStrictEqual(stops, ['ch-4'], 'should emit session-stop for the wedged channel');
        assert.ok(!server.runningChannels['ch-4'], 'wedged channel should be gone');
        assert.strictEqual(connection.closeCount, 1, 'wedged socket should be closed');
    });

    it('leaves a healthy channel alone', () => {
        wireChannel(healthyReaderWriter());
        server.checkTimedOutChannel();

        assert.deepStrictEqual(stops, [], 'healthy channel must not be torn down');
        assert.ok(server.runningChannels['ch-4']);
    });

    it('keeps the sender-gone path on the 5 s event clock, not the payload clock', () => {
        const channel = wireChannel(wedgedReaderWriter());
        const gone = Date.now() - 60_000;
        channel.lastEvent = gone;
        channel.lastPayload = gone;

        server.checkTimedOutChannel();

        // Both predicates match; the event one must win so the logs attribute correctly.
        assert.deepStrictEqual(stops, ['ch-4'], 'should tear down exactly once');
    });

    it('evicts the fd from node-srt\'s connection map on cleanup', () => {
        wireChannel(healthyReaderWriter());
        server.cleanupConnection(connection, fd, worker);

        assert.deepStrictEqual(connectionMap, {},
            'cleanup must preserve node-srt\'s internal closing listener, which evicts the fd');
    });

    it('is idempotent when cleanup is reached from several paths at once', () => {
        wireChannel(healthyReaderWriter());
        server.cleanupConnection(connection, fd, worker);
        server.cleanupConnection(connection, fd, worker);

        assert.deepStrictEqual(stops, ['ch-4'], 'session-stop must be emitted once');
        assert.strictEqual(connection.closeCount, 1, 'socket must be closed once');
    });

    // The idempotency guard must not skip the runningSessions bookkeeping: this loop
    // drains by re-calling cleanup, so a guarded early return would spin forever.
    it('still drains stopRunningSession after the connection was already cleaned', function () {
        this.timeout(2000);
        wireChannel(healthyReaderWriter());
        server.cleanupConnection(connection, fd, worker);
        server.runningSessions['sess-1'] = [{ connection, fd, worker }]; // resurrect a stale entry

        server.stopRunningSession(fd.session);

        assert.ok(!server.runningSessions['sess-1'], 'drain must terminate and clear the session');
    });
});
