/**
 * Per-stream hardening — regressions found on the live bot path.
 *
 *   K1  a reconnect during a channel stop must not have its context deleted by
 *       the OUTGOING stop (which would strand the successor: "no channel
 *       context" on every frame -> zero captions for the rest of the session),
 *       and the superseded stop must publish NO 'session-stop' either — that
 *       event is the channel's deactivate, and it would drop the successor's
 *       live session back to 'ready'.
 *   K3  the N sub-ASR flushes of a channel stop run CONCURRENTLY (a channel at
 *       the default cap took ~23 s to publish its end-of-stream marker).
 *   K6  a `join` landing AFTER the participant's first tagged frame re-keys the
 *       already-created sub-ASR (id AND name), instead of leaving every caption
 *       of that participant unattributed.
 *   K8  a `leave` carrying the reserved overflow tag 255 is ignored (it would
 *       otherwise flush and dispose the ASR every capped participant speaks into).
 *   K9  orphan channel contexts are reaped, and a LIVE channel never is.
 *   C4  no sub-ASR can be created for a channel that is tearing down, and a
 *       straggler that appears anyway is disposed instead of leaking — but the
 *       sweep is restricted to per-stream sub-keys, so a LEGACY successor
 *       registered under the bare `${ck}` key survives. The teardown branch is
 *       likewise chosen from the KEYS being torn down, never from a channel
 *       context that may have outlived its stream.
 *   C8  the FIRST frame of every participant is buffered, not lost (the sub-ASR
 *       is created and fed in the same tick, before the async init()).
 *   C9  a participant leave's trailing finals are published BEFORE the channel's
 *       end-of-stream marker, which must stay the provably-last final.
 *   S1  a REPLACED connection's late 'close' must not wipe the SUCCESSOR's state.
 *   K10 teardown is IDEMPOTENT PER CONNECTION: an abnormal socket close fires
 *       'error' AND 'close', and a replaced connection is cleaned by
 *       onConnection and again by its own late 'close' — one connection must
 *       still publish exactly ONE 'session-stop', because the duplicate lands
 *       inside the first stop's multi-second flush window and runs against the
 *       SUCCESSOR's state. And the ownership gate that backs it up recognises a
 *       LEGACY successor (a demoted bot, a plain WS client), which registers no
 *       channel context and can only be seen through its bare `${ck}` ASR.
 *
 * Same plumbing as test_perstream_demux.js: the WebsocketServer needs no mocks;
 * the StreamingServer pulls native deps through SRTServer, so the SRT/RTMP
 * modules are mocked in require.cache and the instance is hand-built via
 * Object.create.
 */

const assert = require('assert');
const { describe, it, before, after } = require('mocha');
const EventEmitter = require('eventemitter3');
const MultiplexedWebsocketServer = require('../components/StreamingServer/websocket/WebsocketServer');
const { setupMocks, fromTranscriber } = require('./helpers/asr_mocks');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ----------------------------------------------------------------------------
// K6 / S1 — WebsocketServer
// ----------------------------------------------------------------------------

describe('WebsocketServer per-stream hardening', () => {
  let server;
  beforeEach(() => {
    server = new MultiplexedWebsocketServer({});
  });

  // K6 — the join control lost the race against the participant's first tagged
  // frame: the sub-ASR already exists and was built with an EMPTY participant.
  // Updating the map alone never re-keys it, so the join must ALSO emit the
  // identity-update signal (with the id, not just the name).
  describe('K6 a late join re-keys the live sub-ASR', () => {
    it('emits participant-rename with name AND id on a join', () => {
      const fd = { session: { id: 's' }, channel: { id: 'c' }, perStream: true, diarizationMode: 'native' };
      server.streamParticipants.set('s_c', new Map());
      const events = [];
      server.on('participant-rename', (...args) => events.push(args));
      const join = Buffer.from(JSON.stringify({
        type: 'participant', action: 'join', participant: { id: 'u9', name: 'Carol', tag: 5 },
      }));
      assert.strictEqual(server.handleControlMessage(fd, join), true);
      assert.deepStrictEqual(events, [['s', 'c', 5, 'Carol', 'u9']]);
      // The map is still updated for a not-yet-created sub-ASR (unchanged).
      assert.strictEqual(server.getStreamParticipants('s', 'c').get(5).name, 'Carol');
    });

    it('carries the id on a rename too (so the ASR can be re-keyed, not just renamed)', () => {
      const fd = { session: { id: 's' }, channel: { id: 'c' }, perStream: true, diarizationMode: 'native' };
      const m = new Map([[5, { id: 'u9', name: 'Carol', tag: 5 }]]);
      server.streamParticipants.set('s_c', m);
      const events = [];
      server.on('participant-rename', (...args) => events.push(args));
      const rename = Buffer.from(JSON.stringify({
        type: 'participant', action: 'rename', id: 'u9', name: 'Caroline', tag: 5,
      }));
      server.handleControlMessage(fd, rename);
      assert.deepStrictEqual(events, [['s', 'c', 5, 'Caroline', 'u9']]);
      assert.strictEqual(m.get(5).name, 'Caroline');
      assert.strictEqual(m.get(5).id, 'u9');
    });

    it('a leave still emits participant-leave only (no identity update)', () => {
      const fd = { session: { id: 's' }, channel: { id: 'c' }, perStream: true, diarizationMode: 'native' };
      server.streamParticipants.set('s_c', new Map([[5, { id: 'u9', name: 'Carol', tag: 5 }]]));
      const renames = [], leaves = [];
      server.on('participant-rename', (...a) => renames.push(a));
      server.on('participant-leave', (...a) => leaves.push(a));
      const leave = Buffer.from(JSON.stringify({
        type: 'participant', action: 'leave', participant: { id: 'u9', name: 'Carol', tag: 5 },
      }));
      server.handleControlMessage(fd, leave);
      assert.deepStrictEqual(leaves, [['s', 'c', 5]]);
      assert.deepStrictEqual(renames, []);
    });
  });

  // S1 — the replaced connection is closed synchronously by onConnection, but
  // its own 'close' event fires later, after the successor re-registered the
  // channel. Running the channel-keyed cleanup then wipes the successor.
  describe('S1 a replaced connection cannot wipe its successor', () => {
    function fakeWs(name) {
      return { name, closed: false, close() { this.closed = true; }, on() {} };
    }
    const session = { id: 's' };

    function connect(ws) {
      const fd = { session, channel: { id: 'c' } };
      server.streamParticipants.set('s_c', new Map([[0, { id: 'u0', name: 'P0', tag: 0 }]]));
      server.speakerTrackers.set('s_c', { marker: ws.name });
      server.addRunningSession(session, ws, fd, null);
      return fd;
    }

    it('the stale close of a REPLACED connection is a no-op for the channel state', () => {
      const stops = [];
      server.on('session-stop', (s, cid) => stops.push([s.id, cid]));

      const ws1 = fakeWs('first');
      const fd1 = connect(ws1);

      // A new connection arrives: onConnection cleans the existing one up...
      server.cleanupWebsocket(ws1, fd1, null);
      assert.deepStrictEqual(stops, [['s', 'c']], 'the replace still stops the old stream');
      assert.strictEqual(server.runningChannels['c'], undefined);

      // ...then the successor registers its own state.
      const ws2 = fakeWs('second');
      const fd2 = connect(ws2);
      assert.strictEqual(server.runningChannels['c'].ws, ws2);

      // Now the FIRST socket's 'close' finally fires.
      server.cleanupWebsocket(ws1, fd1, null);

      assert.deepStrictEqual(stops, [['s', 'c']], 'no spurious session-stop for the successor');
      assert.strictEqual(server.runningChannels['c'].ws, ws2, "successor still owns the channel");
      assert.ok(server.getStreamParticipants('s', 'c'), "successor's participant map survived");
      assert.strictEqual(server.getSpeakerTracker('s', 'c').marker, 'second');
      assert.strictEqual(server.runningSessions['s'].length, 1);
      assert.strictEqual(server.runningSessions['s'][0].ws, ws2);
      assert.ok(fd2, 'successor fd still registered');
    });

    it('a normal (non-replaced) close still cleans everything up', () => {
      const stops = [];
      server.on('session-stop', (s, cid) => stops.push([s.id, cid]));
      const ws = fakeWs('only');
      const fd = connect(ws);

      server.cleanupWebsocket(ws, fd, null);

      assert.deepStrictEqual(stops, [['s', 'c']]);
      assert.strictEqual(server.runningChannels['c'], undefined);
      assert.strictEqual(server.getStreamParticipants('s', 'c'), null);
      assert.strictEqual(server.getSpeakerTracker('s', 'c'), null);
      assert.strictEqual(server.runningSessions['s'], undefined);
      assert.strictEqual(ws.closed, true);
    });

    // The identity-keyed removal of the connection's own runningSessions entry
    // is what keeps this loop finite when two entries share a channel id.
    it('stopRunningSession terminates even with two connections on one channel', () => {
      const ws1 = fakeWs('first'), ws2 = fakeWs('second');
      connect(ws1);
      connect(ws2);
      assert.strictEqual(server.runningSessions['s'].length, 2);
      server.stopRunningSession(session);
      assert.strictEqual(server.runningSessions['s'], undefined, 'every entry was drained');
    });
  });

  // K10 — the only guard on the 'session-stop' emit was `superseded`, read from
  // runningChannels; the FIRST cleanup pass of a connection deletes that entry,
  // so every later pass for the SAME connection saw no owner, concluded it was
  // not superseded, and emitted a SECOND stop for the channel — by then possibly
  // owned by a successor. 'session-stop' is a CHANNEL event and _stopAsr gets
  // only (session, channelId), so it structurally cannot tell that duplicate
  // from a legitimate successor stop: the dedupe has to live here, where the
  // connection identity (`fd`, minted once per connection in onConnection) is.
  describe('K10 a connection stops its stream exactly once', () => {
    class FakeSocket extends EventEmitter {
      constructor(name) { super(); this.name = name; this.closed = false; }
      close() { this.closed = true; }
    }
    const session = { id: 's' };

    it('an abnormal close (ws fires error THEN close) emits ONE session-stop', () => {
      const stops = [];
      server.on('session-stop', (s, cid) => stops.push([s.id, cid]));
      const ws = new FakeSocket('only');
      const fd = { session, channel: { id: 'c' }, perStream: true };
      server.streamParticipants.set('s_c', new Map());

      server.initPcm(ws, fd);   // wires cleanupWebsocket to BOTH 'close' and 'error'
      ws.emit('error');
      ws.emit('close');

      assert.deepStrictEqual(stops, [['s', 'c']], 'one connection, one stop');
      assert.strictEqual(server.runningChannels['c'], undefined, 'still fully cleaned up');
      assert.strictEqual(server.getStreamParticipants('s', 'c'), null);
      assert.strictEqual(ws.closed, true);
    });

    it('the replacement path (onConnection cleanup + the socket own late close) emits ONE too', () => {
      const stops = [];
      server.on('session-stop', (s, cid) => stops.push([s.id, cid]));
      const ws = new FakeSocket('replaced');
      const fd = { session, channel: { id: 'c' } };
      server.addRunningSession(session, ws, fd, null);

      // onConnection replaces the connection: runningChannels['c'] is deleted here...
      server.cleanupWebsocket(ws, fd, null);
      // ...so this second pass (the replaced socket's own late 'close', which
      // normally beats the successor's init message) sees no owner at all.
      server.cleanupWebsocket(ws, fd, null);

      assert.deepStrictEqual(stops, [['s', 'c']],
        'the replaced connection must not stop the channel a second time');
    });

    it('the latch is PER CONNECTION: a new connection still emits its own stop', () => {
      const stops = [];
      server.on('session-stop', (s, cid) => stops.push([s.id, cid]));
      const ws1 = new FakeSocket('first');
      const fd1 = { session, channel: { id: 'c' } };
      server.addRunningSession(session, ws1, fd1, null);
      server.cleanupWebsocket(ws1, fd1, null);

      const ws2 = new FakeSocket('second');
      const fd2 = { session, channel: { id: 'c' } };
      server.addRunningSession(session, ws2, fd2, null);
      server.cleanupWebsocket(ws2, fd2, null);

      assert.deepStrictEqual(stops, [['s', 'c'], ['s', 'c']],
        'each connection publishes its own stop exactly once');
    });

    it('a superseded connection never emits, and cannot start emitting later', () => {
      const stops = [];
      server.on('session-stop', (s, cid) => stops.push([s.id, cid]));
      const ws1 = new FakeSocket('first');
      const fd1 = { session, channel: { id: 'c' } };
      server.addRunningSession(session, ws1, fd1, null);
      // The successor registers first (S1): ws1's close is superseded.
      const ws2 = new FakeSocket('second');
      server.addRunningSession(session, ws2, { session, channel: { id: 'c' } }, null);

      server.cleanupWebsocket(ws1, fd1, null);   // superseded -> silent
      assert.deepStrictEqual(stops, []);
      // The successor then goes away, clearing runningChannels; a late pass for
      // the DEAD first connection must stay silent all the same.
      delete server.runningChannels['c'];
      server.cleanupWebsocket(ws1, fd1, null);
      assert.deepStrictEqual(stops, [], 'a cleaned-up connection never stops a channel again');
    });

    // The latch is armed BEFORE the emit, never after: a listener throwing
    // synchronously would otherwise unwind past the assignment and leave the
    // dead connection free to emit a second stop on its next cleanup pass.
    it('a throwing session-stop listener cannot unwind the latch', () => {
      let emits = 0;
      server.on('session-stop', () => { emits++; throw new Error('listener blew up'); });
      const ws = new FakeSocket('throwing');
      const fd = { session, channel: { id: 'c' } };
      server.addRunningSession(session, ws, fd, null);

      assert.throws(() => server.cleanupWebsocket(ws, fd, null), /listener blew up/);
      assert.strictEqual(fd.stopEmitted, true, 'the latch was armed before the emit');

      delete server.runningChannels['c'];
      server.cleanupWebsocket(ws, fd, null);
      assert.strictEqual(emits, 1, 'the dead connection did not emit a second stop');
    });
  });
});

// ----------------------------------------------------------------------------
// K1 / K3 / K8 / K9 / C4 / C8 / C9 — StreamingServer + ASR
// ----------------------------------------------------------------------------

describe('StreamingServer per-stream teardown hardening', () => {
  let StreamingServer, ASR, teardown, srtCache, rtmpCache;
  const ORIG_MIN_AUDIO_BUFFER = process.env.MIN_AUDIO_BUFFER;

  before(() => {
    const srtPath = fromTranscriber('components/StreamingServer/srt/SRTServer.js');
    const rtmpPath = fromTranscriber('components/StreamingServer/rtmp/RTMPServer.js');
    srtCache = require.cache[srtPath];
    rtmpCache = require.cache[rtmpPath];
    class DummyServer extends EventEmitter { start() {} stop() {} setSessions() {} }
    require.cache[srtPath] = { id: srtPath, filename: srtPath, loaded: true, exports: DummyServer };
    require.cache[rtmpPath] = { id: rtmpPath, filename: rtmpPath, loaded: true, exports: DummyServer };

    teardown = setupMocks({
      invalidate: [
        fromTranscriber('ASR/index.js'),
        fromTranscriber('ASR/fake/index.js'),
        fromTranscriber('components/StreamingServer/index.js'),
      ],
      mockWs: false,
      circularBuffer: true,
    });
    const liveSrtPath = require.resolve('live-srt-lib');
    require.cache[liveSrtPath].exports.Component = require(fromTranscriber('../lib/component.js'));
    StreamingServer = require('../components/StreamingServer/index.js').StreamingServer;
    ASR = require('../ASR/index.js');
    // 1 ms => 1 byte threshold with the SAMPLE_RATE/BYTES_PER_SAMPLE of tests.js.
    process.env.MIN_AUDIO_BUFFER = '1';
  });

  after(() => {
    if (ORIG_MIN_AUDIO_BUFFER === undefined) delete process.env.MIN_AUDIO_BUFFER;
    else process.env.MIN_AUDIO_BUFFER = ORIG_MIN_AUDIO_BUFFER;
    if (teardown) teardown();
    const srtPath = fromTranscriber('components/StreamingServer/srt/SRTServer.js');
    const rtmpPath = fromTranscriber('components/StreamingServer/rtmp/RTMPServer.js');
    if (srtCache) require.cache[srtPath] = srtCache; else delete require.cache[srtPath];
    if (rtmpCache) require.cache[rtmpPath] = rtmpCache; else delete require.cache[rtmpPath];
    delete require.cache[fromTranscriber('components/StreamingServer/index.js')];
    delete require.cache[fromTranscriber('ASR/index.js')];
  });

  function makeServer(log) {
    const inst = Object.create(StreamingServer.prototype);
    inst.ASRs = new Map();
    inst.lastSegmentIds = new Map();
    inst.maxAsrPerChannel = StreamingServer._resolveCap(process.env.MAX_CONCURRENT_ASR_PER_CHANNEL);
    inst.channels = new Map();
    inst.pendingLeaves = new Map();
    inst.servers = [];
    inst.channelReaperInterval = null;
    inst.channelReaperIntervalMs = 60000;
    inst.emitted = [];
    inst.emit = (...args) => {
      inst.emitted.push(args);
      if (log) log.push(`emit:${args[0]}`);
      return true;
    };
    return inst;
  }

  const session = { id: 'sess' };
  function makeChannel() {
    return {
      id: 'chan',
      enableLiveTranscripts: false, // forces FakeTranscriber
      keepAudio: false,
      transcriberProfile: { config: { type: 'fake', languages: [] } },
      translations: [],
      lastSegmentId: 0,
    };
  }
  function fakeWsServer(participants) {
    const m = new Map(participants.map(p => [p.tag, p]));
    return { getStreamParticipants: () => m };
  }
  function markPerStream(inst, ck, channel, firstSegmentId = 1) {
    const ctx = { session, channel, allocator: { next: firstSegmentId }, registeredAt: Date.now() };
    inst.channels.set(ck, ctx);
    return ctx;
  }
  async function settle(asr) {
    await new Promise(r => setImmediate(r));
    if (asr) await asr._transitionLock;
  }

  // A sub-ASR stand-in with a controllable flush duration: the real one costs
  // ASR_STOP_FLUSH_TIMEOUT_MS + ASR_STOP_SETTLE_MS, far too slow to assert
  // ordering and concurrency on.
  function fakeAsr(name, log, delayMs = 0) {
    return {
      name, flushed: false, detached: false, disposed: false,
      async flushFinals() {
        if (delayMs) await sleep(delayMs);
        this.flushed = true;
        log.push(`flush:${name}`);
      },
      streamStopped() { log.push('marker'); },
      removeAllListeners() { this.detached = true; },
      dispose() { this.disposed = true; log.push(`dispose:${name}`); },
    };
  }

  // K1 — cleanupWebsocket emits 'session-stop' SYNCHRONOUSLY from the new
  // connection's handler, so the successor's session-start lands INSIDE the
  // outgoing stop's flush window.
  describe('K1 a reconnect during a stop keeps its own context', () => {
    it('does not delete the successor context, nor write the stale cursor over it', async () => {
      const log = [];
      const inst = makeServer(log);
      const ck = 'sess_chan';
      const ctxA = markPerStream(inst, ck, makeChannel(), 5);
      inst.ASRs.set(`${ck}#0`, fakeAsr('a', log, 30));

      const stopP = inst._stopAsr(session, 'chan');           // enters the flush await
      const ctxB = markPerStream(inst, ck, makeChannel(), 1); // reconnect re-registers
      assert.notStrictEqual(ctxA, ctxB);
      await stopP;

      assert.strictEqual(inst.channels.get(ck), ctxB, "the successor's context survives");
      assert.strictEqual(inst.lastSegmentIds.has(ck), false,
        "the stale allocator cursor is not written over the one the successor consumed");
    });

    it('leaves the successor sub-ASR alone (no straggler sweep across the switch)', async () => {
      const log = [];
      const inst = makeServer(log);
      const ck = 'sess_chan';
      markPerStream(inst, ck, makeChannel(), 5);
      inst.ASRs.set(`${ck}#0`, fakeAsr('old', log, 30));

      const stopP = inst._stopAsr(session, 'chan');
      markPerStream(inst, ck, makeChannel(), 1);
      const successor = fakeAsr('new', log, 0);
      inst.ASRs.set(`${ck}#1`, successor);   // the reconnected channel is speaking
      await stopP;

      assert.strictEqual(inst.ASRs.get(`${ck}#1`), successor, 'successor ASR still registered');
      assert.strictEqual(successor.disposed, false, 'successor ASR was not disposed');
    });

    it('still cleans the context up when NO reconnect happened (unchanged)', async () => {
      const log = [];
      const inst = makeServer(log);
      const ck = 'sess_chan';
      markPerStream(inst, ck, makeChannel(), 5);
      inst.ASRs.set(`${ck}#0`, fakeAsr('a', log, 0));

      await inst._stopAsr(session, 'chan');

      assert.strictEqual(inst.channels.has(ck), false);
      assert.strictEqual(inst.lastSegmentIds.get(ck), 5, 'cursor preserved for the next connection');
    });

    // K1 stops ONE LINE short without this: 'session-stop' is wired to
    // BrokerClient.deactivate(), which publishes streamStatus 'inactive' for the
    // CHANNEL. A superseded stop's deactivate lands AFTER the successor's
    // activate (the flush awaits outlast the successor's session-start) and the
    // Scheduler's stale-owner guard cannot catch it — both connections carry the
    // same transcriberId — so the channel goes inactive and the session drops
    // back to 'ready' while the successor is still streaming captions.
    it('does not deactivate the successor: a superseded stop emits NO session-stop', async () => {
      const log = [];
      const inst = makeServer(log);
      const ck = 'sess_chan';
      markPerStream(inst, ck, makeChannel(), 5);
      inst.ASRs.set(`${ck}#0`, fakeAsr('outgoing', log, 30));

      const stopP = inst._stopAsr(session, 'chan');
      markPerStream(inst, ck, makeChannel(), 1);   // the reconnect re-registers
      await stopP;

      assert.strictEqual(inst.emitted.filter(e => e[0] === 'session-stop').length, 0,
        "a superseded stop must not deactivate the successor's channel");
    });

    it('still emits exactly one session-stop when NO reconnect happened', async () => {
      const log = [];
      const inst = makeServer(log);
      const ck = 'sess_chan';
      markPerStream(inst, ck, makeChannel(), 5);
      inst.ASRs.set(`${ck}#0`, fakeAsr('a', log, 0));

      await inst._stopAsr(session, 'chan');

      assert.strictEqual(inst.emitted.filter(e => e[0] === 'session-stop').length, 1,
        'the ordinary stop still publishes its deactivate');
    });

    // The same gate is needed on the D3a lazy branch (0 ASR), which is reachable
    // whenever the channel's only participant is still flushing its trailing
    // finals: the stop awaits that leave, and a reconnect lands inside the wait.
    it('the lazy-hole branch is gated too', async () => {
      const log = [];
      const inst = makeServer(log);
      const ck = 'sess_chan';
      const ctxA = markPerStream(inst, ck, makeChannel(), 5);
      let release;
      inst._trackPendingLeave(ck, new Promise(r => { release = r; }));

      const stopP = inst._stopAsr(session, 'chan');   // 0 ASR: awaits the leave
      const ctxB = markPerStream(inst, ck, makeChannel(), 1);
      assert.notStrictEqual(ctxA, ctxB);
      release();
      assert.strictEqual(await stopP, true);

      assert.strictEqual(inst.emitted.filter(e => e[0] === 'session-stop').length, 0,
        'a superseded lazy-hole stop does not deactivate the successor either');
      assert.strictEqual(inst.channels.get(ck), ctxB, "the successor's context survives");
    });

    it('the lazy-hole branch still deactivates when it owns the channel', async () => {
      const log = [];
      const inst = makeServer(log);
      const ck = 'sess_chan';
      markPerStream(inst, ck, makeChannel(), 5);

      assert.strictEqual(await inst._stopAsr(session, 'chan'), true);

      assert.strictEqual(inst.emitted.filter(e => e[0] === 'session-stop').length, 1,
        'the session is not left stuck when nothing superseded the stop');
      assert.strictEqual(inst.channels.has(ck), false);
    });

    // Segment-id continuity across the same window. The successor's
    // session-start runs INSIDE the outgoing stop's flush window, where
    // `lastSegmentIds` has not been written yet (it is written after the
    // flushes, and only if the context is still the outgoing one) and where the
    // outgoing sub-ASR are still drawing the ids of their trailing finals from
    // the live allocator. Seeding the successor from resolveInitialSegmentId
    // therefore restarted it on ids the outgoing connection had already
    // published. Both connections must share ONE monotonic id source.
    it('a session-start landing mid-stop continues the outgoing allocator', async () => {
      const log = [];
      const inst = makeServer(log);
      await inst.initServer('SRT');
      const srv = inst.servers[0];
      srv.getStreamParticipants = () => new Map([[0, { id: 'u0', name: 'P0', tag: 0 }]]);
      const ck = 'sess_chan';

      srv.emit('session-start', session, makeChannel());
      const ctxA = inst.channels.get(ck);
      assert.strictEqual(ctxA.allocator.next, 1, 'a first connection starts from the resolved cursor');
      ctxA.allocator.next = 12;                      // the outgoing connection published ids 1..11
      inst.ASRs.set(`${ck}#0`, fakeAsr('outgoing', log, 30));

      const stopP = inst._stopAsr(session, 'chan');  // enters the flush await
      srv.emit('session-start', session, makeChannel());   // the reconnect lands inside it
      const ctxB = inst.channels.get(ck);

      assert.notStrictEqual(ctxB, ctxA, 'a fresh context was registered');
      assert.strictEqual(ctxB.allocator, ctxA.allocator,
        'the successor shares the live allocator instead of re-reading a stale cursor');
      assert.strictEqual(ctxB.allocator.next, 12,
        'the successor does not restart on ids the outgoing connection already published');
      await stopP;
      inst.stopChannelReaper();
    });

    // The shared allocator dies with the context, so its cursor must be
    // published by whoever destroys it. A successor that INHERITED the allocator
    // but never received a tagged frame is torn down through the lazy branch,
    // which used to drop the context without preserving anything; the
    // predecessor's own write was then skipped by its identity guard, and the
    // next connection reseeded from the stale broadcast channel.lastSegmentId.
    it('a successor torn down through the lazy branch still preserves the cursor', async () => {
      const log = [];
      const inst = makeServer(log);
      await inst.initServer('SRT');
      const srv = inst.servers[0];
      srv.getStreamParticipants = () => new Map([[0, { id: 'u0', name: 'P0', tag: 0 }]]);
      const ck = 'sess_chan';

      srv.emit('session-start', session, makeChannel());
      const ctxA = inst.channels.get(ck);
      ctxA.allocator.next = 42;                       // A published ids 1..41
      inst.ASRs.set(`${ck}#0`, fakeAsr('outgoing', log, 30));

      const stopP = inst._stopAsr(session, 'chan');   // A's stop parks on the flush
      srv.emit('session-start', session, makeChannel());
      const ctxB = inst.channels.get(ck);
      assert.strictEqual(ctxB.allocator, ctxA.allocator, 'sanity: B inherited the allocator');

      await inst._stopAsr(session, 'chan');           // B never spoke -> lazy branch
      await stopP;

      assert.strictEqual(inst.lastSegmentIds.get(ck), 42,
        'the shared cursor survives the lazy teardown of the successor');
      inst.stopChannelReaper();
    });

    // A LEGACY successor (a keepAudio bot demoted by the mixedRecording gate,
    // the native->web re-route, any plain WS client) cannot share the allocator
    // OBJECT, so it must at least snapshot its cursor: the retained broadcast
    // value is only republished on activate/deactivate and can be hundreds of
    // ids stale.
    it('a LEGACY successor seeds from the live allocator, not the stale broadcast', async () => {
      const inst = makeServer(null);
      await inst.initServer('SRT');
      const srv = inst.servers[0];              // no getStreamParticipants -> legacy branch
      const ck = 'sess_chan';
      const seeded = [];
      inst._wireAsr = (s, c, opts) => { seeded.push(opts.initialSegmentId); return fakeAsr('legacy', null, 0); };

      markPerStream(inst, ck, makeChannel(), 42);   // outgoing per-stream ctx, still live
      const channel = makeChannel();
      channel.lastSegmentId = 9;                    // the stale retained broadcast
      srv.emit('session-start', session, channel);

      assert.deepStrictEqual(seeded, [42],
        'the legacy successor continues the live allocator instead of restarting at 10');
    });

    it('a legacy start with NO per-stream context still resolves normally', async () => {
      const inst = makeServer(null);
      await inst.initServer('SRT');
      const srv = inst.servers[0];
      const seeded = [];
      inst._wireAsr = (s, c, opts) => { seeded.push(opts.initialSegmentId); return fakeAsr('legacy', null, 0); };

      const channel = makeChannel();
      channel.lastSegmentId = 9;
      srv.emit('session-start', session, channel);

      assert.deepStrictEqual(seeded, [10], 'unchanged: channel.lastSegmentId + 1');
    });
  });

  // K10 — the WS layer used to emit 'session-stop' TWICE for one connection
  // ('error' then 'close', or a replacement plus the replaced socket's own late
  // close). The duplicate always landed inside the first stop's multi-second
  // flush window. cleanupWebsocket's per-connection latch is the load-bearing
  // fix; this is the _stopAsr-side guard that backs it up — a stop for the very
  // context that is already tearing down must not steal its marker, its cursor
  // or its deactivate.
  describe('K10 a duplicate stop cannot steal an in-flight teardown', () => {
    it('leaves the cursor, the marker and the deactivate to the stop that owns them', async () => {
      const log = [];
      const inst = makeServer(log);
      const ck = 'sess_chan';
      const ctx = markPerStream(inst, ck, makeChannel(), 42);
      inst.ASRs.set(`${ck}#0`, fakeAsr('a', log, 30));

      const first = inst._stopAsr(session, 'chan');          // parked on the flush
      const dup = await inst._stopAsr(session, 'chan');      // the duplicate lands inside it
      assert.strictEqual(dup, false, 'the duplicate is a no-op');
      assert.strictEqual(inst.channels.get(ck), ctx,
        'the in-flight stop still owns the context its identity guard tests');
      await first;

      assert.strictEqual(inst.lastSegmentIds.get(ck), 42,
        'the segment-id cursor is written by the owning stop (it was silently lost)');
      assert.strictEqual(inst.emitted.filter(e => e[0] === 'session-stop').length, 1,
        'exactly one deactivate for one connection');
      assert.ok(log.indexOf('marker') < log.indexOf('emit:session-stop'),
        'the deactivate is still published strictly AFTER the end-of-stream marker');
      assert.strictEqual(inst.channels.has(ck), false);
      assert.strictEqual(inst.ASRs.size, 0, '0 orphans');
    });

    it('a duplicate arriving after the successor already stopped normally changes nothing', async () => {
      const log = [];
      const inst = makeServer(log);
      const ck = 'sess_chan';
      markPerStream(inst, ck, makeChannel(), 42);
      inst.ASRs.set(`${ck}#0`, fakeAsr('a', log, 0));
      await inst._stopAsr(session, 'chan');            // connection A stops
      markPerStream(inst, ck, makeChannel(), 99);      // B connects...
      inst.ASRs.set(`${ck}#0`, fakeAsr('b', log, 0));
      await inst._stopAsr(session, 'chan');            // ...and stops normally

      const late = await inst._stopAsr(session, 'chan');   // A's late duplicate

      assert.strictEqual(late, false);
      assert.strictEqual(inst.emitted.filter(e => e[0] === 'session-stop').length, 2,
        'one deactivate per real connection, none for the duplicate');
      assert.strictEqual(inst.lastSegmentIds.get(ck), 99, "B's cursor is not overwritten");
      assert.strictEqual(inst.channels.size, 0);
      assert.strictEqual(inst.ASRs.size, 0);
    });

    it('a stop for a channel that never had an ASR stays a silent no-op', async () => {
      const inst = makeServer([]);
      assert.strictEqual(await inst._stopAsr(session, 'chan'), false);
      assert.strictEqual(inst.emitted.length, 0, 'no deactivate for a channel we never owned');
      assert.strictEqual(inst.channels.size, 0);
      assert.strictEqual(inst.lastSegmentIds.size, 0);
    });

    it('a tagged frame and a participant leave racing the stop leave nothing behind', async () => {
      const log = [];
      const inst = makeServer(log);
      const ck = 'sess_chan';
      markPerStream(inst, ck, makeChannel(), 7);
      inst.ASRs.set(`${ck}#0`, fakeAsr('speaking', log, 30));
      inst.ASRs.set(`${ck}#1`, fakeAsr('leaver', log, 0));
      const srv = { getStreamParticipants: () => new Map([[2, { id: 'u2', name: 'Late', tag: 2 }]]) };

      const stopP = inst._stopAsr(session, 'chan');
      const leaveP = inst._disposePerStreamParticipant('sess', 'chan', 1);
      const created = inst._getOrCreatePerStreamAsr(srv, 'sess', 'chan', 2);
      await stopP;
      await leaveP;

      assert.strictEqual(created, null, 'C4: no sub-ASR is created for a stopping channel');
      assert.strictEqual(inst.ASRs.size, 0, '0 orphans');
      assert.strictEqual(log.filter(x => x === 'marker').length, 1, 'exactly one end-of-stream marker');
      assert.ok(log.indexOf('flush:leaver') < log.indexOf('marker'),
        "C9: the leaver's trailing finals precede the marker");
      assert.strictEqual(inst.lastSegmentIds.get(ck), 7);
      assert.strictEqual(inst.emitted.filter(e => e[0] === 'session-stop').length, 1);
      assert.strictEqual(inst.channels.has(ck), false);
    });
  });

  // K10 — the ownership gate (_cleanupPerStream: `this.channels.get(ck) === ctx`)
  // can only ever detect a PER-STREAM successor. A LEGACY successor registers no
  // channel context at all, so the gate passed and the stop deactivated a LIVE
  // stream. Such a successor is the ordinary case, not an exotic one: it is what
  // the mixedRecording gate produces when it DEMOTES a keepAudio bot, what the
  // native->web re-route sends, and what any plain WS client is.
  describe('K10 a LEGACY successor is recognised by the ownership gate', () => {
    it('a per-stream stop taken over by a legacy successor emits NO session-stop', async () => {
      const log = [];
      const inst = makeServer(log);
      const ck = 'sess_chan';
      markPerStream(inst, ck, makeChannel(), 42);
      inst.ASRs.set(`${ck}#0`, fakeAsr('outgoing', log, 30));

      const stopP = inst._stopAsr(session, 'chan');
      // The legacy session-start branch: an ASR under the BARE `${ck}` key and
      // no channel context whatsoever.
      const successor = fakeAsr('legacy-successor', log, 0);
      inst.ASRs.set(ck, successor);
      await stopP;

      assert.strictEqual(inst.emitted.filter(e => e[0] === 'session-stop').length, 0,
        'deactivating here drops a LIVE session back to ready while it publishes captions');
      assert.strictEqual(inst.ASRs.get(ck), successor, 'the successor ASR is still registered');
      assert.strictEqual(successor.flushed, false, 'and was not flushed');
      assert.strictEqual(successor.detached, false, 'nor detached');
      assert.strictEqual(successor.disposed, false, 'nor disposed (the C4 sweep restriction holds)');
      assert.ok(log.includes('marker'), 'the outgoing stream still publishes its end-of-stream marker');
      assert.strictEqual(inst.lastSegmentIds.get(ck), 42, 'and still preserves its own cursor');
      assert.strictEqual(inst.channels.has(ck), false,
        'the stale per-stream context is still dropped (nobody owns it any more)');
    });

    it('the lazy-hole branch is gated by the same evidence', async () => {
      const log = [];
      const inst = makeServer(log);
      const ck = 'sess_chan';
      markPerStream(inst, ck, makeChannel(), 5);
      let release;
      inst._trackPendingLeave(ck, new Promise(r => { release = r; }));

      const stopP = inst._stopAsr(session, 'chan');   // 0 ASR: awaits the leave
      const successor = fakeAsr('legacy-successor', log, 0);
      inst.ASRs.set(ck, successor);                   // the takeover lands in the wait
      release();
      await stopP;

      assert.strictEqual(inst.emitted.filter(e => e[0] === 'session-stop').length, 0,
        'a lazy-hole stop must not deactivate a legacy successor either');
      assert.strictEqual(inst.ASRs.get(ck), successor, 'the successor ASR is untouched');
      assert.strictEqual(successor.disposed, false);
    });

    it('a LEGACY stop taken over by a legacy successor still deactivates exactly as today', async () => {
      const log = [];
      const inst = makeServer(log);
      const ck = 'sess_chan';
      const outgoing = fakeAsr('legacy-outgoing', log, 30);
      outgoing.segmentId = 57;
      inst.ASRs.set(ck, outgoing);   // no channel context: a legacy channel

      const stopP = inst._stopAsr(session, 'chan');
      const successor = fakeAsr('legacy-successor', log, 0);
      inst.ASRs.set(ck, successor);  // the reconnect re-registers the bare key
      await stopP;

      assert.deepStrictEqual(log,
        ['flush:legacy-outgoing', 'marker', 'dispose:legacy-outgoing', 'emit:session-stop'],
        'byte-for-byte the legacy ordering, deactivate included');
      assert.strictEqual(inst.emitted.filter(e => e[0] === 'session-stop').length, 1,
        'the legacy path keeps deactivating exactly as it does today');
      assert.strictEqual(inst.lastSegmentIds.get(ck), 58, "the outgoing ASR's own counter is preserved");
      assert.strictEqual(inst.ASRs.get(ck), successor, "the successor's ASR is left alone");
      assert.strictEqual(successor.disposed, false);
    });

    it('a per-stream stop with no takeover at all still deactivates', async () => {
      const log = [];
      const inst = makeServer(log);
      const ck = 'sess_chan';
      markPerStream(inst, ck, makeChannel(), 42);
      inst.ASRs.set(`${ck}#0`, fakeAsr('a', log, 0));

      await inst._stopAsr(session, 'chan');

      assert.strictEqual(inst.emitted.filter(e => e[0] === 'session-stop').length, 1,
        'the gate must not swallow an ordinary stop');
      assert.strictEqual(inst.lastSegmentIds.get(ck), 42);
    });
  });

  // K3 — N * (flush timeout + settle) was ~23 s at the default cap before the
  // end-of-stream marker and the deactivate could be published.
  describe('K3 sub-ASR flushes run concurrently', () => {
    it('a 4-sub-ASR stop costs ~one flush, not four, and still emits the marker last', async () => {
      const log = [];
      const inst = makeServer(log);
      const ck = 'sess_chan';
      markPerStream(inst, ck, makeChannel());
      for (let t = 0; t < 4; t++) inst.ASRs.set(`${ck}#${t}`, fakeAsr(`a${t}`, log, 60));

      const started = Date.now();
      await inst._stopAsr(session, 'chan');
      const elapsed = Date.now() - started;

      assert.ok(elapsed < 150, `stop took ${elapsed}ms, expected ~60ms (concurrent), not ~240ms`);
      const markerIndex = log.indexOf('marker');
      assert.notStrictEqual(markerIndex, -1, 'the end-of-stream marker was emitted');
      for (let t = 0; t < 4; t++) {
        assert.ok(log.indexOf(`flush:a${t}`) < markerIndex, `flush of a${t} precedes the marker`);
      }
      assert.ok(log.indexOf('dispose:a0') > markerIndex, 'dispose happens after the marker');
      assert.strictEqual(inst.ASRs.size, 0, '0 orphans');
    });

    it('one rejecting flush does not prevent the marker or the other flushes', async () => {
      const log = [];
      const inst = makeServer(log);
      const ck = 'sess_chan';
      markPerStream(inst, ck, makeChannel());
      const boom = fakeAsr('boom', log, 0);
      boom.flushFinals = async () => { throw new Error('provider stop exploded'); };
      inst.ASRs.set(`${ck}#0`, boom);
      inst.ASRs.set(`${ck}#1`, fakeAsr('ok', log, 0));

      await inst._stopAsr(session, 'chan');

      assert.ok(log.includes('flush:ok'));
      assert.ok(log.includes('marker'));
      assert.strictEqual(boom.disposed, true, 'the failed ASR is still disposed');
      assert.strictEqual(inst.ASRs.size, 0);
    });
  });

  // C4 — a tagged frame arriving during the flush awaits used to lazily create a
  // sub-ASR invisible to the teardown snapshot: never flushed, never disposed,
  // still publishing captions after the channel's end-of-stream marker.
  describe('C4 no sub-ASR can be created for a channel that is tearing down', () => {
    it('refuses lazy creation while stopping and drops the frame', async () => {
      const log = [];
      const inst = makeServer(log);
      const ck = 'sess_chan';
      markPerStream(inst, ck, makeChannel());
      inst.ASRs.set(`${ck}#0`, fakeAsr('a', log, 30));
      const wsServer = fakeWsServer([{ id: 'u1', name: 'Alice', tag: 1 }]);

      const stopP = inst._stopAsr(session, 'chan');
      const late = inst._getOrCreatePerStreamAsr(wsServer, 'sess', 'chan', 1);
      assert.strictEqual(late, null, 'no ASR is created for a stopping channel');
      assert.strictEqual(inst.ASRs.has(`${ck}#1`), false);
      await stopP;
      assert.strictEqual(inst.ASRs.size, 0, '0 orphans');
    });

    it('disposes a straggler that appeared behind the snapshot anyway', async () => {
      const log = [];
      const inst = makeServer(log);
      const ck = 'sess_chan';
      markPerStream(inst, ck, makeChannel());
      const straggler = fakeAsr('straggler', log, 0);
      const first = fakeAsr('a', log, 10);
      // Simulate a creation that slipped past the `stopping` gate, mid-flush.
      const origFlush = first.flushFinals.bind(first);
      first.flushFinals = async () => {
        inst.ASRs.set(`${ck}#9`, straggler);
        await origFlush();
      };
      inst.ASRs.set(`${ck}#0`, first);

      await inst._stopAsr(session, 'chan');

      assert.strictEqual(inst.ASRs.has(`${ck}#9`), false, 'straggler removed from the map');
      assert.strictEqual(straggler.detached, true, 'straggler detached before dispose (no late captions)');
      assert.strictEqual(straggler.disposed, true, 'straggler disposed, not leaked');
      assert.ok(log.indexOf('dispose:straggler') > log.indexOf('marker'));
    });

    // The straggler re-scan matched the BARE `${ck}` key too. Such a key can
    // only have been created by the LEGACY session-start branch, i.e. by a
    // SUCCESSOR connection that landed inside this stop's flush window and was
    // not granted per-stream (a plain WS client taking the channel over, or a
    // keepAudio channel whose new bot cannot mix and is DEMOTED). The K1
    // identity guard does not cover it — such a successor registers no channel
    // context, so `this.channels.get(ck) === ctx` still passes — and the sweep
    // detached and disposed the successor's brand-new ASR, leaving the channel
    // with none: every later frame hit "No ASR found" and zero captions were
    // produced for the rest of the session.
    it('never sweeps a LEGACY successor ASR registered under the bare channel key', async () => {
      const log = [];
      const inst = makeServer(log);
      const ck = 'sess_chan';
      markPerStream(inst, ck, makeChannel(), 5);
      inst.ASRs.set(`${ck}#0`, fakeAsr('outgoing', log, 30));

      const stopP = inst._stopAsr(session, 'chan');
      // The replacement connection is NOT per-stream: it registers no context
      // and creates a single legacy ASR under the bare key, mid-flush.
      const successor = fakeAsr('legacy-successor', log, 0);
      inst.ASRs.set(ck, successor);
      await stopP;

      assert.strictEqual(inst.ASRs.get(ck), successor, 'the legacy successor ASR is still registered');
      assert.strictEqual(successor.disposed, false, 'and was not disposed');
      assert.strictEqual(successor.detached, false, 'nor detached from its listeners');
      assert.strictEqual(successor.flushed, false, 'nor torn down by the per-stream branch');
    });

    it('still sweeps a real per-stream straggler alongside it', async () => {
      const log = [];
      const inst = makeServer(log);
      const ck = 'sess_chan';
      markPerStream(inst, ck, makeChannel(), 5);
      const straggler = fakeAsr('straggler', log, 0);
      const successor = fakeAsr('legacy-successor', log, 0);
      const first = fakeAsr('a', log, 10);
      const origFlush = first.flushFinals.bind(first);
      first.flushFinals = async () => {
        inst.ASRs.set(`${ck}#9`, straggler);   // a per-stream straggler
        inst.ASRs.set(ck, successor);          // and a legacy successor
        await origFlush();
      };
      inst.ASRs.set(`${ck}#0`, first);

      await inst._stopAsr(session, 'chan');

      assert.strictEqual(straggler.disposed, true, 'the sub-key straggler is still disposed');
      assert.strictEqual(successor.disposed, false, 'the bare key is left alone');
      assert.deepStrictEqual([...inst.ASRs.keys()], [ck]);
    });

    it('the stopping gate is per-channel: another channel still creates ASR', async () => {
      const log = [];
      const inst = makeServer(log);
      markPerStream(inst, 'sess_chan', makeChannel());
      const other = makeChannel();
      other.id = 'other';
      markPerStream(inst, 'sess_other', other);
      inst.ASRs.set('sess_chan#0', fakeAsr('a', log, 20));
      const wsServer = fakeWsServer([{ id: 'u1', name: 'Alice', tag: 0 }]);

      const stopP = inst._stopAsr(session, 'chan');
      const asr = inst._getOrCreatePerStreamAsr(wsServer, 'sess', 'other', 0);
      assert.ok(asr, 'an unrelated channel is unaffected by the teardown');
      await stopP;
      await settle(asr);
    });
  });

  // The teardown branch used to be chosen from the CHANNEL CONTEXT while the key
  // snapshot matches the bare legacy `${ck}` as well as `${ck}#*`.
  describe('a stale per-stream context cannot hijack a LEGACY channel stop', () => {
    it('keeps the legacy ordering: marker, own segment cursor, dispose', async () => {
      const log = [];
      const inst = makeServer(log);
      const ck = 'sess_chan';
      // A per-stream context that outlived its stream: its own stop was
      // superseded by a reconnect, and the K9 reaper cannot collect it while the
      // live LEGACY ASR keeps _hasChannelAsr() true for the same ck.
      const stale = markPerStream(inst, ck, makeChannel(), 1);
      const legacy = fakeAsr('legacy', log, 0);
      legacy.segmentId = 57;
      inst.ASRs.set(ck, legacy);

      await inst._stopAsr(session, 'chan');

      assert.strictEqual(inst.lastSegmentIds.get(ck), 58,
        "the LIVE ASR's own counter is preserved, not the stale allocator's cursor");
      assert.ok(log.includes('marker'), 'the legacy branch still emits its own end-of-stream marker');
      assert.strictEqual(legacy.flushed, true);
      assert.strictEqual(legacy.disposed, true);
      assert.strictEqual(inst.ASRs.size, 0, '0 orphans');
      assert.strictEqual(inst.emitted.filter(e => e[0] === 'session-stop').length, 1);
      assert.strictEqual(inst.channels.has(ck), false, 'and the stale context is dropped');
      assert.notStrictEqual(stale.allocator.next, 58, 'sanity: the two cursors really differ');
    });

    it('a genuine per-stream stop is unaffected (sub-keys present)', async () => {
      const log = [];
      const inst = makeServer(log);
      const ck = 'sess_chan';
      markPerStream(inst, ck, makeChannel(), 9);
      inst.ASRs.set(`${ck}#0`, fakeAsr('p0', log, 0));

      await inst._stopAsr(session, 'chan');

      assert.strictEqual(inst.lastSegmentIds.get(ck), 9,
        'the shared allocator is still the per-stream cursor');
    });

    // The MIRROR-image hole: sub-ASR present, context ABSENT. Routing the branch
    // on the context as well as the keys sent those down the LEGACY ordering —
    // one end-of-stream marker per sub-ASR (N blank caption rows), sequential
    // flushes instead of the concurrent K3 ones, and preserveSegmentId once per
    // sub-ASR with the last iterated winning the channel cursor.
    it('sub-ASR with NO channel context still use the per-stream ordering', async () => {
      const log = [];
      const inst = makeServer(log);
      const ck = 'sess_chan';
      inst.ASRs.set(`${ck}#0`, fakeAsr('t0', log, 60));
      inst.ASRs.set(`${ck}#1`, fakeAsr('t1', log, 60));
      assert.strictEqual(inst.channels.has(ck), false, 'no context, by construction');

      const started = Date.now();
      await inst._stopAsr(session, 'chan');
      const elapsed = Date.now() - started;

      assert.strictEqual(log.filter(x => x === 'marker').length, 1,
        'ONE end-of-stream marker for the channel, not one per sub-ASR');
      assert.ok(elapsed < 150, `stop took ${elapsed}ms, expected ~60ms (concurrent), not ~120ms`);
      assert.strictEqual(inst.lastSegmentIds.has(ck), false,
        'no shared allocator, so there is no cursor to preserve');
      assert.strictEqual(inst.ASRs.size, 0, '0 orphans');
      assert.strictEqual(inst.emitted.filter(e => e[0] === 'session-stop').length, 1);
    });
  });

  // C9 — the leave's flushFinals() raced the channel stop, so trailing finals
  // could land AFTER the end-of-stream marker and after the deactivate.
  describe('C9 a channel stop waits for in-flight participant teardowns', () => {
    it('publishes the leaving participant flush before the marker', async () => {
      const log = [];
      const inst = makeServer(log);
      const ck = 'sess_chan';
      markPerStream(inst, ck, makeChannel());
      inst.ASRs.set(`${ck}#0`, fakeAsr('leaver', log, 40));
      inst.ASRs.set(`${ck}#1`, fakeAsr('live', log, 5));

      const leaveP = inst._disposePerStreamParticipant('sess', 'chan', 0);
      const stopP = inst._stopAsr(session, 'chan');
      await Promise.all([leaveP, stopP]);

      assert.ok(log.indexOf('flush:leaver') < log.indexOf('marker'),
        `leave flush must precede the marker (log: ${log.join(',')})`);
      assert.ok(log.indexOf('marker') < log.indexOf('emit:session-stop'));
    });

    it('also waits when the leaver was the channel\'s only ASR (lazy-hole branch)', async () => {
      const log = [];
      const inst = makeServer(log);
      const ck = 'sess_chan';
      markPerStream(inst, ck, makeChannel());
      inst.ASRs.set(`${ck}#0`, fakeAsr('leaver', log, 40));

      const leaveP = inst._disposePerStreamParticipant('sess', 'chan', 0);
      const stopP = inst._stopAsr(session, 'chan');
      const [, stopped] = await Promise.all([leaveP, stopP]);

      assert.strictEqual(stopped, true);
      assert.ok(log.indexOf('flush:leaver') < log.indexOf('emit:session-stop'),
        `the deactivate must not precede the leaver's trailing finals (log: ${log.join(',')})`);
    });

    it('drops the pending-leave entry once settled (no unbounded growth)', async () => {
      const log = [];
      const inst = makeServer(log);
      const ck = 'sess_chan';
      markPerStream(inst, ck, makeChannel());
      inst.ASRs.set(`${ck}#0`, fakeAsr('leaver', log, 5));
      await inst._disposePerStreamParticipant('sess', 'chan', 0);
      await sleep(0);
      assert.strictEqual(inst.pendingLeaves.has(ck), false);
    });
  });

  // K8 — 255 is the SHARED overflow bucket. A leave carrying it would flush and
  // dispose the ASR every capped participant is still speaking into.
  describe('K8 a leave on a reserved key is ignored', () => {
    it('never disposes the shared overflow ASR', async () => {
      const log = [];
      const inst = makeServer(log);
      const ck = 'sess_chan';
      markPerStream(inst, ck, makeChannel());
      const overflow = fakeAsr('overflow', log, 0);
      inst.ASRs.set(`${ck}#255`, overflow);

      assert.strictEqual(await inst._disposePerStreamParticipant('sess', 'chan', 255), false);
      assert.strictEqual(inst.ASRs.get(`${ck}#255`), overflow, 'shared overflow ASR untouched');
      assert.strictEqual(overflow.flushed, false);
      assert.strictEqual(overflow.disposed, false);
    });

    it('never disposes the channel recorder', async () => {
      const log = [];
      const inst = makeServer(log);
      const ck = 'sess_chan';
      markPerStream(inst, ck, makeChannel());
      const recorder = fakeAsr('rec', log, 0);
      inst.ASRs.set(`${ck}#rec`, recorder);

      assert.strictEqual(await inst._disposePerStreamParticipant('sess', 'chan', 'rec'), false);
      assert.strictEqual(inst.ASRs.get(`${ck}#rec`), recorder, 'archive owner untouched');
      assert.strictEqual(recorder.disposed, false);
    });

    it('a real participant leave is still honoured', async () => {
      const log = [];
      const inst = makeServer(log);
      const ck = 'sess_chan';
      markPerStream(inst, ck, makeChannel());
      inst.ASRs.set(`${ck}#3`, fakeAsr('p3', log, 0));
      assert.strictEqual(await inst._disposePerStreamParticipant('sess', 'chan', 3), true);
      assert.strictEqual(inst.ASRs.has(`${ck}#3`), false);
    });
  });

  // K9 — this.channels had no reaper (unlike WebsocketServer.reapOrphanTrackers).
  describe('K9 orphan channel contexts are reaped, live ones never', () => {
    function agedCtx(inst, ck, channelId, ageMs) {
      const channel = makeChannel();
      channel.id = channelId;
      const ctx = { session, channel, allocator: { next: 1 }, registeredAt: Date.now() - ageMs };
      inst.channels.set(ck, ctx);
      return ctx;
    }

    it('reaps a context with no ASR and no live stream', () => {
      const inst = makeServer();
      agedCtx(inst, 'sess_gone', 'gone', 120000);
      inst.reapOrphanChannels();
      assert.strictEqual(inst.channels.has('sess_gone'), false);
    });

    it('never reaps a channel that still has an ASR (sub-ASR or recorder)', () => {
      const inst = makeServer();
      agedCtx(inst, 'sess_live', 'live', 120000);
      agedCtx(inst, 'sess_arch', 'arch', 120000);
      inst.ASRs.set('sess_live#0', {});
      inst.ASRs.set('sess_arch#rec', {});
      inst.reapOrphanChannels();
      assert.strictEqual(inst.channels.has('sess_live'), true);
      assert.strictEqual(inst.channels.has('sess_arch'), true);
    });

    it('never reaps a channel a streaming server still holds a participant map for', () => {
      const inst = makeServer();
      agedCtx(inst, 'sess_ws', 'ws', 120000);
      inst.servers = [{ getStreamParticipants: (s, c) => (c === 'ws' ? new Map() : null) }];
      inst.reapOrphanChannels();
      assert.strictEqual(inst.channels.has('sess_ws'), true);
    });

    it('never reaps a freshly registered channel (the D3a lazy hole has 0 ASR)', () => {
      const inst = makeServer();
      agedCtx(inst, 'sess_fresh', 'fresh', 0);
      inst.reapOrphanChannels();
      assert.strictEqual(inst.channels.has('sess_fresh'), true, 'grace period protects a silent new channel');
    });

    it("the '#' boundary is respected (sess_chan1 does not keep sess_chan alive)", () => {
      const inst = makeServer();
      agedCtx(inst, 'sess_chan', 'chan', 120000);
      inst.ASRs.set('sess_chan1', {});
      inst.reapOrphanChannels();
      assert.strictEqual(inst.channels.has('sess_chan'), false);
    });

    // The warn-once Set of the `record-data` handler is keyed by a ck that may
    // never have had a channel context (a stale bot still shipping the 0x02 flow
    // after its channel was torn down, a mismatched session/channel id). Neither
    // _cleanupPerStream nor the loop above can reach such an entry — both are
    // driven by this.channels — so the throttle Set was the one thing the reaper
    // did not bound.
    it('prunes the warn-once bookkeeping of channels that are gone for good', () => {
      const inst = makeServer();
      inst._noRecorderWarned = new Set(['sess_ghost', 'sess_live', 'sess_marked']);
      inst.ASRs.set('sess_live#0', {});
      agedCtx(inst, 'sess_marked', 'marked', 0); // freshly registered: kept by the grace period

      inst.reapOrphanChannels();

      assert.deepStrictEqual([...inst._noRecorderWarned].sort(), ['sess_live', 'sess_marked'],
        'only the entry with no context AND no ASR is dropped');
    });

    // K9 lazily armed: this.channels only ever holds per-stream contexts, so an
    // SRT/RTMP-only (or non-per-stream) deployment must not carry a 60 s
    // interval over an always-empty Map.
    describe('the reaper is armed by the first per-stream channel, not at startup', () => {
      async function serverWith(participants) {
        const inst = makeServer();
        await inst.initServer('SRT');
        const srv = inst.servers[0];
        srv.getStreamParticipants = () => participants;
        return { inst, srv };
      }

      it('a legacy (non-per-stream) session-start arms nothing', async () => {
        const { inst, srv } = await serverWith(null);
        srv.emit('session-start', session, makeChannel());
        assert.strictEqual(inst.channelReaperInterval, null, 'no interval on a legacy-only process');
        assert.ok(inst.ASRs.has('sess_chan'), 'precondition: the legacy ASR was really created');
      });

      it('disarms itself once there is nothing left to reap', () => {
        const inst = makeServer();
        inst.startChannelReaper();
        assert.ok(inst.channelReaperInterval, 'precondition: armed');
        const channel = makeChannel();
        channel.id = 'gone';
        inst.channels.set('sess_gone', { session, channel, allocator: { next: 1 }, registeredAt: Date.now() - 120000 });

        inst.reapOrphanChannels();

        assert.strictEqual(inst.channels.size, 0);
        assert.strictEqual(inst.channelReaperInterval, null,
          'no 60 s interval is carried over an always-empty Map');
      });

      it('stays armed while a channel context is still held', () => {
        const inst = makeServer();
        inst.startChannelReaper();
        const channel = makeChannel();
        channel.id = 'live';
        inst.channels.set('sess_live', { session, channel, allocator: { next: 1 }, registeredAt: Date.now() - 120000 });
        inst.ASRs.set('sess_live#0', {});

        inst.reapOrphanChannels();

        assert.ok(inst.channelReaperInterval, 'a live channel keeps the reaper armed');
        inst.stopChannelReaper();
      });

      it('re-arms on the next per-stream channel after a disarm', async () => {
        const { inst, srv } = await serverWith(new Map([[0, { id: 'u0', name: 'P0', tag: 0 }]]));
        srv.emit('session-start', session, makeChannel());
        assert.ok(inst.channelReaperInterval, 'armed by the first per-stream channel');

        inst.channels.clear();
        inst.reapOrphanChannels();
        assert.strictEqual(inst.channelReaperInterval, null, 'disarmed with its last channel');

        srv.emit('session-start', session, makeChannel());
        assert.ok(inst.channelReaperInterval, 'the next per-stream channel re-arms it');
        inst.stopChannelReaper();
      });

      it('a per-stream session-start arms it exactly once', async () => {
        const { inst, srv } = await serverWith(new Map([[0, { id: 'u0', name: 'P0', tag: 0 }]]));
        srv.emit('session-start', session, makeChannel());
        const armed = inst.channelReaperInterval;
        assert.ok(armed, 'the first per-stream channel arms the reaper');
        srv.emit('session-start', session, makeChannel());
        assert.strictEqual(inst.channelReaperInterval, armed, 'still a single interval');
        inst.stopChannelReaper();
      });
    });

    it('start/stopChannelReaper are idempotent and do not hold the event loop', () => {
      const inst = makeServer();
      inst.startChannelReaper();
      const first = inst.channelReaperInterval;
      assert.ok(first);
      inst.startChannelReaper();
      assert.strictEqual(inst.channelReaperInterval, first, 'no second interval');
      inst.stopChannelReaper();
      assert.strictEqual(inst.channelReaperInterval, null);
      inst.stopChannelReaper(); // no throw
    });
  });

  // The shared overflow ASR is the DESTINATION of the cap, not one of its slots:
  // counting it shrank the channel to cap-1 dedicated ASR for the rest of the
  // call as soon as one overflow happened, so a freed slot could never be
  // re-filled.
  describe('the overflow ASR does not consume a cap slot', () => {
    it('a freed slot is re-usable after an overflow already happened', async () => {
      const orig = process.env.MAX_CONCURRENT_ASR_PER_CHANNEL;
      process.env.MAX_CONCURRENT_ASR_PER_CHANNEL = '2';
      try {
        const inst = makeServer();
        inst.maxAsrPerChannel = StreamingServer._resolveCap(process.env.MAX_CONCURRENT_ASR_PER_CHANNEL);
        const ck = 'sess_chan';
        markPerStream(inst, ck, makeChannel());
        const parts = [];
        for (let t = 0; t < 4; t++) parts.push({ id: `u${t}`, name: `P${t}`, tag: t });
        const wsServer = fakeWsServer(parts);

        const a = inst._getOrCreatePerStreamAsr(wsServer, 'sess', 'chan', 0);
        const b = inst._getOrCreatePerStreamAsr(wsServer, 'sess', 'chan', 1);
        const overflow = inst._getOrCreatePerStreamAsr(wsServer, 'sess', 'chan', 2); // -> #255
        await settle(a); await settle(b); await settle(overflow);
        assert.ok(inst.ASRs.has(`${ck}#255`), 'the cap engaged');

        // P0 leaves: one dedicated slot is free again (1 dedicated + overflow).
        await inst._disposePerStreamParticipant('sess', 'chan', 0);
        const c = inst._getOrCreatePerStreamAsr(wsServer, 'sess', 'chan', 3);
        await settle(c);

        assert.ok(inst.ASRs.has(`${ck}#3`), 'the freed slot is re-used by a DEDICATED ASR');
        assert.notStrictEqual(c, overflow, 'the new participant is not collapsed onto overflow');
        assert.strictEqual(c.participantName, 'P3');
      } finally {
        if (orig === undefined) delete process.env.MAX_CONCURRENT_ASR_PER_CHANNEL;
        else process.env.MAX_CONCURRENT_ASR_PER_CHANNEL = orig;
      }
    });

    // C2 routing: the overflow bucket is the ONE sub-ASR fed by several
    // participants at once, so its incoming meetingTimeMs interleaves and goes
    // backwards on nearly every frame. Creating it as a SHARED stream is what
    // keeps it from building an audio->meeting map it can never be right about
    // (and from logging a "bot restart or u32 wrap" WARN at frame rate).
    it('creates the overflow ASR as a shared stream, so it never builds a timeline', async () => {
      const orig = process.env.MAX_CONCURRENT_ASR_PER_CHANNEL;
      process.env.MAX_CONCURRENT_ASR_PER_CHANNEL = '1';
      try {
        const inst = makeServer();
        inst.maxAsrPerChannel = StreamingServer._resolveCap(process.env.MAX_CONCURRENT_ASR_PER_CHANNEL);
        const ck = 'sess_chan';
        markPerStream(inst, ck, makeChannel());
        const wsServer = fakeWsServer([
          { id: 'u0', name: 'P0', tag: 0 }, { id: 'u1', name: 'P1', tag: 1 }, { id: 'u2', name: 'P2', tag: 2 },
        ]);
        const dedicated = inst._getOrCreatePerStreamAsr(wsServer, 'sess', 'chan', 0);
        const overflow = inst._getOrCreatePerStreamAsr(wsServer, 'sess', 'chan', 1);
        const memoized = inst._getOrCreatePerStreamAsr(wsServer, 'sess', 'chan', 2);
        await settle(dedicated); await settle(overflow);

        assert.strictEqual(memoized, overflow, 'both capped tags share one bucket');
        assert.strictEqual(overflow.sharedStream, true, 'the overflow bucket is a SHARED stream');
        assert.strictEqual(dedicated.sharedStream, false, 'a dedicated sub-ASR is not');

        const warns = [];
        overflow.logger.warn = (msg) => warns.push(msg);
        // Exactly what the 'data' handler does: forward the frame's meetingTimeMs.
        // Two capped participants interleave theirs through this one ASR.
        overflow.transcribe(Buffer.from([1]), 5000);
        overflow.transcribe(Buffer.from([2]), 1000);
        overflow.transcribe(Buffer.from([3]), 7000);
        assert.strictEqual(overflow.timeline, null, 'no map is built for the shared bucket');
        assert.deepStrictEqual(warns, [], 'and no bogus backwards-clock WARN is logged');

        // The dedicated sub-ASR is untouched: it still builds its map.
        dedicated.transcribe(Buffer.from([1]), 0);
        dedicated.transcribe(Buffer.from([2]), 3000);
        assert.ok(dedicated.timeline, 'a dedicated sub-ASR still gets a timeline');
        assert.strictEqual(dedicated.timeline.breaks.length, 1);
      } finally {
        if (orig === undefined) delete process.env.MAX_CONCURRENT_ASR_PER_CHANNEL;
        else process.env.MAX_CONCURRENT_ASR_PER_CHANNEL = orig;
      }
    });

    it('a tag already collapsed onto overflow stays there (memoized routing)', async () => {
      const orig = process.env.MAX_CONCURRENT_ASR_PER_CHANNEL;
      process.env.MAX_CONCURRENT_ASR_PER_CHANNEL = '1';
      try {
        const inst = makeServer();
        inst.maxAsrPerChannel = StreamingServer._resolveCap(process.env.MAX_CONCURRENT_ASR_PER_CHANNEL);
        const ck = 'sess_chan';
        const ctx = markPerStream(inst, ck, makeChannel());
        const wsServer = fakeWsServer([{ id: 'u0', name: 'P0', tag: 0 }, { id: 'u1', name: 'P1', tag: 1 }]);
        const a = inst._getOrCreatePerStreamAsr(wsServer, 'sess', 'chan', 0);
        const first = inst._getOrCreatePerStreamAsr(wsServer, 'sess', 'chan', 1);
        const again = inst._getOrCreatePerStreamAsr(wsServer, 'sess', 'chan', 1);
        await settle(a); await settle(first);
        assert.strictEqual(first, again);
        assert.ok(ctx.overflowTags.has(1));
        assert.strictEqual(inst.ASRs.size, 2, 'cap (1) + the single shared overflow');
      } finally {
        if (orig === undefined) delete process.env.MAX_CONCURRENT_ASR_PER_CHANNEL;
        else process.env.MAX_CONCURRENT_ASR_PER_CHANNEL = orig;
      }
    });
  });

  // C8 — the sub-ASR is created and fed in the SAME tick (the 'data' handler
  // lazily creates then transcribes), but init() — which used to allocate
  // audioBuffer — only runs on the next microtask.
  describe('C8 the first frame of a participant is never lost', () => {
    it('buffers a transcribe() issued in the same tick as construction', async () => {
      const asr = new ASR(session, makeChannel(), { participantId: 'u1', participantName: 'Alice' });
      assert.doesNotThrow(() => asr.transcribe(Buffer.from([1, 2])), 'first frame must not throw');
      assert.deepStrictEqual(
        Buffer.from(asr.audioBuffer.getAudioBuffer()), Buffer.from([1, 2]),
        'the first frame is buffered, not dropped');
      await settle(asr);
    });

    it('forwards that first frame to the provider once it is ready', async () => {
      const asr = new ASR(session, makeChannel(), { participantId: 'u1', participantName: 'Alice' });
      asr.transcribe(Buffer.from([1, 2]));   // same tick as construction
      await settle(asr);
      asr.transcribe(Buffer.from([3]));      // provider is READY now
      assert.strictEqual(asr.provider.transcribeCallCount, 1);
      assert.deepStrictEqual(
        Buffer.from(asr.provider.lastTranscribedBuffer), Buffer.from([1, 2, 3]),
        'the very first frame reached the provider with the rest');
    });

    it('the demux path (lazy create + immediate transcribe) loses nothing', async () => {
      const inst = makeServer();
      const ck = 'sess_chan';
      markPerStream(inst, ck, makeChannel());
      const wsServer = fakeWsServer([{ id: 'u1', name: 'Alice', tag: 0 }]);
      // Exactly what the 'data' handler does on the first tagged frame.
      const asr = inst._getOrCreatePerStreamAsr(wsServer, 'sess', 'chan', 0);
      asr.transcribe(Buffer.from([9, 9]));
      await settle(asr);
      assert.deepStrictEqual(Buffer.from(asr.audioBuffer.getAudioBuffer()), Buffer.from([9, 9]));
    });
  });

  // K6 (StreamingServer side) — the sub-ASR built from an EMPTY participant is
  // re-keyed by the late join: id AND name, so the captions stop being anonymous.
  describe('K6 a late identity update re-keys the live sub-ASR', () => {
    it('sets participantId and participantName on the already-created ASR', async () => {
      const inst = makeServer();
      const ck = 'sess_chan';
      markPerStream(inst, ck, makeChannel());
      // The join has not arrived yet: the map has no entry for tag 4.
      const wsServer = fakeWsServer([]);
      const asr = inst._getOrCreatePerStreamAsr(wsServer, 'sess', 'chan', 4);
      await settle(asr);
      const finals = [];
      asr.on('final', t => finals.push(t));
      asr.provider.emit('transcribed', { text: 'anonymous', isPrimary: true });
      assert.strictEqual(finals[0].locutor, undefined, 'unattributed before the join lands');

      // The late join arrives (WebsocketServer emits participant-rename).
      inst._renamePerStreamParticipant('sess', 'chan', 4, 'Carol', 'u9');
      assert.strictEqual(asr.participantName, 'Carol');
      assert.strictEqual(asr.participantId, 'u9');

      asr.provider.emit('transcribed', { text: 'named', isPrimary: true });
      assert.strictEqual(finals[1].locutor, 'Carol');
      assert.strictEqual(finals[1].participantId, 'u9', 'stable id carried for downstream attribution');
    });

    it('a name-only rename keeps the known id', async () => {
      const inst = makeServer();
      markPerStream(inst, 'sess_chan', makeChannel());
      const wsServer = fakeWsServer([{ id: 'u1', name: 'Alice', tag: 0 }]);
      const asr = inst._getOrCreatePerStreamAsr(wsServer, 'sess', 'chan', 0);
      await settle(asr);
      inst._renamePerStreamParticipant('sess', 'chan', 0, 'Alice Cooper');
      assert.strictEqual(asr.participantName, 'Alice Cooper');
      assert.strictEqual(asr.participantId, 'u1', 'id preserved when the update carries none');
    });

    it('reserved keys are never re-keyed', async () => {
      const inst = makeServer();
      const ck = 'sess_chan';
      markPerStream(inst, ck, makeChannel());
      const overflow = { setParticipant() { throw new Error('overflow must not be re-keyed'); } };
      const recorder = { setParticipant() { throw new Error('recorder must not be re-keyed'); } };
      inst.ASRs.set(`${ck}#255`, overflow);
      inst.ASRs.set(`${ck}#rec`, recorder);
      assert.doesNotThrow(() => inst._renamePerStreamParticipant('sess', 'chan', 255, 'X', 'x'));
      assert.doesNotThrow(() => inst._renamePerStreamParticipant('sess', 'chan', 'rec', 'X', 'x'));
    });
  });
});

// ----------------------------------------------------------------------------
// Discrete translations must carry the source caption's participantId
// ----------------------------------------------------------------------------

describe('ASREvents discrete translations attribution', () => {
  const asrEvents = require('../components/BrokerClient/controllers/ASREvents.js');

  function makeCtx() {
    const streamingServer = new EventEmitter();
    const published = [];
    const ctx = {
      client: { publish: (topic, payload) => published.push({ topic, payload }) },
      app: { components: { StreamingServer: streamingServer } },
    };
    return { ctx, streamingServer, published };
  }

  it('carries participantId on a discrete translation (per-stream / native diarization)', async () => {
    const { ctx, streamingServer, published } = makeCtx();
    await asrEvents.call(ctx);
    streamingServer.emit('final', {
      segmentId: 7, text: 'bonjour', lang: 'fr-FR', locutor: 'Alice', participantId: 'u1',
      translations: { en: 'hello' },
    }, 'sess', 'chan', { translations: [] });

    const translation = published.find(p => p.topic.endsWith('/final/translations'));
    assert.ok(translation, 'the translation was published');
    assert.strictEqual(translation.payload.participantId, 'u1',
      'the translated line is attributed to the SAME participant as its source caption');
    assert.strictEqual(translation.payload.locutor, 'Alice');
    const canonical = published.find(p => p.topic.endsWith('/final'));
    assert.strictEqual(canonical.payload.participantId, 'u1');
  });

  it('does the same for partials', async () => {
    const { ctx, streamingServer, published } = makeCtx();
    await asrEvents.call(ctx);
    streamingServer.emit('partial', {
      segmentId: 8, text: 'bonj', lang: 'fr-FR', locutor: 'Alice', participantId: 'u1',
      translations: { en: 'hell' },
    }, 'sess', 'chan', { translations: [] });
    const translation = published.find(p => p.topic.endsWith('/partial/translations'));
    assert.strictEqual(translation.payload.participantId, 'u1');
  });

  it('omits the key entirely without diarization (legacy payload shape unchanged)', async () => {
    const { ctx, streamingServer, published } = makeCtx();
    await asrEvents.call(ctx);
    streamingServer.emit('final', {
      segmentId: 9, text: 'bonjour', lang: 'fr-FR', locutor: null,
      translations: { en: 'hello' },
    }, 'sess', 'chan', { translations: [] });
    const translation = published.find(p => p.topic.endsWith('/final/translations'));
    assert.strictEqual('participantId' in translation.payload, false);
  });
});
