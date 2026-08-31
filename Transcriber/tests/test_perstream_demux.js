/**
 * T8 — per-stream demux unit tests.
 *
 *   1. WebsocketServer._parseTaggedFrame: valid / too-short / wrong-magic, plus
 *      the perStream init/ACK negotiation and late-joiner control routing.
 *   2. StreamingServer demux: 2 tags -> 2 ASR; 7th tag (cap=6) -> #255;
 *      session-stop disposes N sub-ASR with 0 orphans; a silent perStream
 *      channel (0 ASR created) still emits session-stop (lazy hole D3a).
 *
 * The WebsocketServer needs no mocks (plain EventEmitter, real logger). The
 * StreamingServer pulls native deps via SRTServer -> linto-node-srt, so we mock
 * the SRT/RTMP server modules in require.cache (they are never exercised here)
 * and use the shared asr_mocks plumbing so the real ASR/index.js + FakeTranscriber
 * run without a backend. The StreamingServer instance is hand-built via
 * Object.create so the heavy Component constructor / server bootstrap is skipped.
 */

const assert = require('assert');
const path = require('path');
const { describe, it, before, after, beforeEach } = require('mocha');
const EventEmitter = require('eventemitter3');
const MultiplexedWebsocketServer = require('../components/StreamingServer/websocket/WebsocketServer');
const { setupMocks, fromTranscriber } = require('./helpers/asr_mocks');

// ----------------------------------------------------------------------------
// 1. WebsocketServer: _parseTaggedFrame + perStream init/ACK/control routing
// ----------------------------------------------------------------------------

describe('WebsocketServer per-stream framing', () => {
  let server;
  beforeEach(() => {
    server = new MultiplexedWebsocketServer({});
  });

  function taggedFrame(tag, tMs, pcm) {
    const header = Buffer.alloc(8);
    header[0] = 0x01;
    header[1] = tag & 0xff;
    header.writeUInt16LE(0, 2);
    header.writeUInt32LE(tMs >>> 0, 4);
    return Buffer.concat([header, pcm]);
  }

  describe('_parseTaggedFrame', () => {
    it('decodes a well-formed tagged frame', () => {
      const pcm = Buffer.from([0x10, 0x20, 0x30, 0x40]);
      const parsed = server._parseTaggedFrame(taggedFrame(7, 123456, pcm));
      assert.ok(parsed);
      assert.strictEqual(parsed.tag, 7);
      assert.strictEqual(parsed.tMs, 123456);
      assert.deepStrictEqual(Buffer.from(parsed.pcm), pcm);
    });

    it('returns null for a frame shorter than the 8-byte header', () => {
      assert.strictEqual(server._parseTaggedFrame(Buffer.from([0x01, 0x02, 0x03])), null);
    });

    it('returns null for a wrong magic byte (not 0x01)', () => {
      const buf = taggedFrame(3, 0, Buffer.from([0, 0]));
      buf[0] = 0x7b; // '{'
      assert.strictEqual(server._parseTaggedFrame(buf), null);
    });

    it('returns null for non-Buffer input', () => {
      assert.strictEqual(server._parseTaggedFrame('not a buffer'), null);
    });

    it('decodes a zero-length PCM payload (header only)', () => {
      const parsed = server._parseTaggedFrame(taggedFrame(255, 0, Buffer.alloc(0)));
      assert.ok(parsed);
      assert.strictEqual(parsed.tag, 255);
      assert.strictEqual(parsed.pcm.length, 0);
    });
  });

  describe('init negotiation + ACK', () => {
    const ORIG = process.env.TRANSCRIBER_PERSTREAM_DIARIZATION;
    afterEachRestore();
    function afterEachRestore() {
      after(() => {
        if (ORIG === undefined) delete process.env.TRANSCRIBER_PERSTREAM_DIARIZATION;
        else process.env.TRANSCRIBER_PERSTREAM_DIARIZATION = ORIG;
      });
    }

    function fakeWs() {
      return { sent: [], send(s) { this.sent.push(JSON.parse(s)); }, on() {}, close() {} };
    }

    it('ACKs perStream:true and populates the map when requested AND env on', () => {
      process.env.TRANSCRIBER_PERSTREAM_DIARIZATION = 'true';
      const ws = fakeWs();
      const fd = { session: { id: 's1' }, channel: { id: 'c1' } };
      const msg = Buffer.from(JSON.stringify({
        type: 'init', encoding: 'pcm', sampleRate: 16000, diarizationMode: 'native',
        perStream: true,
        participants: [{ id: 'u1', name: 'Alice', tag: 0 }, { id: 'u2', name: 'Bob', tag: 1 }],
      }));
      const cb = server.handleInitMessage(ws, msg, fd);
      assert.ok(typeof cb === 'function');
      assert.strictEqual(fd.perStream, true);
      const ack = ws.sent.find(m => m.type === 'ack');
      assert.ok(ack && ack.perStream === true);
      const m = server.getStreamParticipants('s1', 'c1');
      assert.ok(m);
      assert.strictEqual(m.size, 2);
      assert.strictEqual(m.get(1).name, 'Bob');
      // No legacy SpeakerTracker is built in per-stream mode.
      assert.strictEqual(server.getSpeakerTracker('s1', 'c1'), null);
    });

    it('ACKs perStream:false (legacy bit-exact) when env is off, even if requested', () => {
      delete process.env.TRANSCRIBER_PERSTREAM_DIARIZATION;
      const ws = fakeWs();
      const fd = { session: { id: 's2' }, channel: { id: 'c2' } };
      const msg = Buffer.from(JSON.stringify({
        type: 'init', encoding: 'pcm', sampleRate: 16000, diarizationMode: 'native',
        perStream: true, participants: [{ id: 'u1', name: 'Alice', tag: 0 }],
      }));
      server.handleInitMessage(ws, msg, fd);
      assert.strictEqual(fd.perStream, false);
      const ack = ws.sent.find(m => m.type === 'ack');
      assert.ok(ack && ack.perStream === false);
      assert.strictEqual(server.getStreamParticipants('s2', 'c2'), null);
      // diarizationMode 'native' still builds the legacy tracker.
      assert.ok(server.getSpeakerTracker('s2', 'c2'));
    });

    it('ACKs perStream:false when env on but bot did not request it', () => {
      process.env.TRANSCRIBER_PERSTREAM_DIARIZATION = 'true';
      const ws = fakeWs();
      const fd = { session: { id: 's3' }, channel: { id: 'c3' } };
      const msg = Buffer.from(JSON.stringify({
        type: 'init', encoding: 'pcm', sampleRate: 16000,
      }));
      server.handleInitMessage(ws, msg, fd);
      assert.strictEqual(fd.perStream, false);
      const ack = ws.sent.find(m => m.type === 'ack');
      assert.ok(ack && ack.perStream === false);
    });
  });

  describe('late-joiner control routing (D3b)', () => {
    it('routes a perStream participant/join into streamParticipants (not the tracker)', () => {
      const fd = { session: { id: 's' }, channel: { id: 'c' }, perStream: true, diarizationMode: 'native' };
      server.streamParticipants.set('s_c', new Map());
      const join = Buffer.from(JSON.stringify({
        type: 'participant', action: 'join', participant: { id: 'u9', name: 'Carol', tag: 5 },
      }));
      assert.strictEqual(server.handleControlMessage(fd, join), true);
      const m = server.getStreamParticipants('s', 'c');
      assert.strictEqual(m.get(5).name, 'Carol');
    });

    it('marks a participant inactive on leave but keeps the mapping', () => {
      const fd = { session: { id: 's' }, channel: { id: 'c' }, perStream: true, diarizationMode: 'native' };
      const m = new Map([[5, { id: 'u9', name: 'Carol', tag: 5 }]]);
      server.streamParticipants.set('s_c', m);
      const leave = Buffer.from(JSON.stringify({
        type: 'participant', action: 'leave', participant: { id: 'u9', name: 'Carol', tag: 5 },
      }));
      assert.strictEqual(server.handleControlMessage(fd, leave), true);
      assert.strictEqual(m.get(5).active, false);
      assert.ok(m.has(5), 'mapping retained for trailing finals');
    });

    it('emits participant-leave so StreamingServer can free the cap slot (#5)', () => {
      const fd = { session: { id: 's' }, channel: { id: 'c' }, perStream: true, diarizationMode: 'native' };
      const m = new Map([[5, { id: 'u9', name: 'Carol', tag: 5 }]]);
      server.streamParticipants.set('s_c', m);
      const events = [];
      server.on('participant-leave', (sid, cid, tag) => events.push([sid, cid, tag]));
      const leave = Buffer.from(JSON.stringify({
        type: 'participant', action: 'leave', participant: { id: 'u9', name: 'Carol', tag: 5 },
      }));
      server.handleControlMessage(fd, leave);
      assert.deepStrictEqual(events, [['s', 'c', 5]]);
    });

    it('handles a mid-call rename: updates the map and emits participant-rename (#7)', () => {
      const fd = { session: { id: 's' }, channel: { id: 'c' }, perStream: true, diarizationMode: 'native' };
      const m = new Map([[5, { id: 'u9', name: 'Carol', tag: 5 }]]);
      server.streamParticipants.set('s_c', m);
      const events = [];
      server.on('participant-rename', (sid, cid, tag, name) => events.push([sid, cid, tag, name]));
      // Documented rename shape: id/name/tag at the top level.
      const rename = Buffer.from(JSON.stringify({
        type: 'participant', action: 'rename', id: 'u9', name: 'Caroline', tag: 5,
      }));
      assert.strictEqual(server.handleControlMessage(fd, rename), true);
      assert.strictEqual(m.get(5).name, 'Caroline', 'stored name updated for lazy creation');
      assert.deepStrictEqual(events, [['s', 'c', 5, 'Caroline']]);
    });

    it('legacy (no perStream) control routing is unchanged', () => {
      const fd = { session: { id: 's' }, channel: { id: 'c' }, diarizationMode: 'asr' };
      const msg = Buffer.from(JSON.stringify({ type: 'participant', action: 'join', participant: { id: 'u1' } }));
      assert.strictEqual(server.handleControlMessage(fd, msg), false);
    });
  });
});

// ----------------------------------------------------------------------------
// 2. StreamingServer demux: lazy N-ASR, cap #255, looped stop, lazy hole
// ----------------------------------------------------------------------------

describe('StreamingServer per-stream demux', () => {
  let StreamingServer, teardown, srtCache, rtmpCache;

  before(() => {
    // Mock the native SRT/RTMP server modules so requiring StreamingServer does
    // not load linto-node-srt / node-media-server.
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
    // StreamingServer extends Component from live-srt-lib; the asr_mocks bundle
    // does not include it, so add the real (dependency-free) Component to the
    // mocked exports before requiring StreamingServer.
    const liveSrtPath = require.resolve('live-srt-lib');
    require.cache[liveSrtPath].exports.Component = require(fromTranscriber('../lib/component.js'));
    StreamingServer = require('../components/StreamingServer/index.js').StreamingServer;
  });

  after(() => {
    if (teardown) teardown();
    const srtPath = fromTranscriber('components/StreamingServer/srt/SRTServer.js');
    const rtmpPath = fromTranscriber('components/StreamingServer/rtmp/RTMPServer.js');
    if (srtCache) require.cache[srtPath] = srtCache; else delete require.cache[srtPath];
    if (rtmpCache) require.cache[rtmpPath] = rtmpCache; else delete require.cache[rtmpPath];
    delete require.cache[fromTranscriber('components/StreamingServer/index.js')];
  });

  // Build a StreamingServer instance WITHOUT the heavy Component constructor /
  // server bootstrap: only the demux state the methods touch + a recording emit.
  function makeServer() {
    const inst = Object.create(StreamingServer.prototype);
    inst.ASRs = new Map();
    inst.lastSegmentIds = new Map();
    inst.maxAsrPerChannel = StreamingServer._resolveCap(process.env.MAX_CONCURRENT_ASR_PER_CHANNEL);
    inst.channels = new Map();
    inst.emitted = [];
    inst.emit = (...args) => { inst.emitted.push(args); return true; };
    return inst;
  }

  // A fake WS server exposing the participant map the demux reads.
  function fakeWsServer(participants) {
    const m = new Map(participants.map(p => [p.tag, p]));
    return { getStreamParticipants: () => m };
  }

  function makeSession() { return { id: 'sess' }; }
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

  // Mark a channel per-stream the way session-start would, then return it.
  function markPerStream(inst, ck, session, channel, firstSegmentId = 1) {
    inst.channels.set(ck, { session, channel, allocator: { next: firstSegmentId } });
  }

  async function settle(asr) {
    await new Promise(r => setImmediate(r));
    if (asr) await asr._transitionLock;
  }

  it('creates one ASR per distinct tag (2 tags -> 2 ASR)', async () => {
    const inst = makeServer();
    const session = makeSession(), channel = makeChannel();
    const ck = 'sess_chan';
    markPerStream(inst, ck, session, channel);
    const wsServer = fakeWsServer([{ id: 'u1', name: 'Alice', tag: 0 }, { id: 'u2', name: 'Bob', tag: 1 }]);

    const a = inst._getOrCreatePerStreamAsr(wsServer, 'sess', 'chan', 0);
    const b = inst._getOrCreatePerStreamAsr(wsServer, 'sess', 'chan', 1);
    const aAgain = inst._getOrCreatePerStreamAsr(wsServer, 'sess', 'chan', 0);

    assert.notStrictEqual(a, b);
    assert.strictEqual(a, aAgain, 'same tag returns the same ASR');
    assert.ok(inst.ASRs.has('sess_chan#0'));
    assert.ok(inst.ASRs.has('sess_chan#1'));
    assert.strictEqual(inst.ASRs.size, 2);
    assert.strictEqual(a.participantName, 'Alice');
    assert.strictEqual(b.participantName, 'Bob');
    await settle(a); await settle(b);
  });

  it('caps at MAX_CONCURRENT_ASR_PER_CHANNEL=6: the 7th tag collapses onto #255', async () => {
    const orig = process.env.MAX_CONCURRENT_ASR_PER_CHANNEL;
    process.env.MAX_CONCURRENT_ASR_PER_CHANNEL = '6';
    try {
      const inst = makeServer();
      const session = makeSession(), channel = makeChannel();
      const ck = 'sess_chan';
      markPerStream(inst, ck, session, channel);
      const parts = [];
      for (let t = 0; t < 8; t++) parts.push({ id: `u${t}`, name: `P${t}`, tag: t });
      const wsServer = fakeWsServer(parts);

      const created = [];
      for (let t = 0; t < 6; t++) created.push(inst._getOrCreatePerStreamAsr(wsServer, 'sess', 'chan', t));
      assert.strictEqual(inst.ASRs.size, 6, '6 distinct sub-ASR under the cap');

      // 7th and 8th distinct tags exceed the cap -> shared overflow ASR #255.
      const seventh = inst._getOrCreatePerStreamAsr(wsServer, 'sess', 'chan', 6);
      const eighth = inst._getOrCreatePerStreamAsr(wsServer, 'sess', 'chan', 7);
      assert.ok(inst.ASRs.has('sess_chan#255'), 'overflow ASR keyed #255');
      assert.strictEqual(seventh, eighth, 'all overflow tags share the single #255 ASR');
      assert.strictEqual(inst.ASRs.size, 7, 'bounded at cap (6) + 1 overflow');
      for (const a of created) await settle(a);
      await settle(seventh);
    } finally {
      if (orig === undefined) delete process.env.MAX_CONCURRENT_ASR_PER_CHANNEL;
      else process.env.MAX_CONCURRENT_ASR_PER_CHANNEL = orig;
    }
  });

  it('shares a monotonic, collision-free segmentId allocator across sibling ASR', async () => {
    const inst = makeServer();
    const session = makeSession(), channel = makeChannel();
    const ck = 'sess_chan';
    markPerStream(inst, ck, session, channel, 1);
    const wsServer = fakeWsServer([{ id: 'u1', name: 'Alice', tag: 0 }, { id: 'u2', name: 'Bob', tag: 1 }]);
    const a = inst._getOrCreatePerStreamAsr(wsServer, 'sess', 'chan', 0);
    const b = inst._getOrCreatePerStreamAsr(wsServer, 'sess', 'chan', 1);
    await settle(a); await settle(b);

    // Each ASR seeded its first id from the shared allocator -> distinct.
    assert.strictEqual(a.segmentId, 1);
    assert.strictEqual(b.segmentId, 2);
    assert.strictEqual(inst.channels.get(ck).allocator.next, 3);

    // Drive a primary final on each: advance draws from the shared allocator.
    const finals = [];
    a.on('final', t => finals.push(['A', t.segmentId]));
    b.on('final', t => finals.push(['B', t.segmentId]));
    a.provider.emit('transcribed', { text: 'hello', isPrimary: true }); // A final seg 1, advance -> 3
    b.provider.emit('transcribed', { text: 'world', isPrimary: true }); // B final seg 2, advance -> 4
    a.provider.emit('transcribed', { text: 'again', isPrimary: true });  // A final seg 3, advance -> next 6
    assert.deepStrictEqual(finals, [['A', 1], ['B', 2], ['A', 3]]);
    // 3 advances consumed ids 3,4,5 (reserving the next "current" id of each
    // ASR from the shared pool); the cursor now points at 6.
    assert.strictEqual(inst.channels.get(ck).allocator.next, 6);
  });

  it('assigns the participant name as locutor (no SpeakerTracker)', async () => {
    const inst = makeServer();
    const session = makeSession(), channel = makeChannel();
    markPerStream(inst, 'sess_chan', session, channel);
    const wsServer = fakeWsServer([{ id: 'u1', name: 'Alice', tag: 0 }]);
    const a = inst._getOrCreatePerStreamAsr(wsServer, 'sess', 'chan', 0);
    await settle(a);
    const finals = [];
    a.on('final', t => finals.push(t));
    a.provider.emit('transcribed', { text: 'hi', isPrimary: true, locutor: 'provider-guess' });
    assert.strictEqual(finals[0].locutor, 'Alice');
  });

  it('session-stop disposes every sub-ASR with 0 orphans + emits session-stop', async () => {
    const inst = makeServer();
    const session = makeSession(), channel = makeChannel();
    const ck = 'sess_chan';
    markPerStream(inst, ck, session, channel);
    const wsServer = fakeWsServer([{ id: 'u1', name: 'Alice', tag: 0 }, { id: 'u2', name: 'Bob', tag: 1 }, { id: 'u3', name: 'Carol', tag: 2 }]);
    const a = inst._getOrCreatePerStreamAsr(wsServer, 'sess', 'chan', 0);
    const b = inst._getOrCreatePerStreamAsr(wsServer, 'sess', 'chan', 1);
    const c = inst._getOrCreatePerStreamAsr(wsServer, 'sess', 'chan', 2);
    await settle(a); await settle(b); await settle(c);
    assert.strictEqual(inst.ASRs.size, 3);

    const ret = await inst._stopAsr(session, 'chan');
    assert.strictEqual(ret, true);
    assert.strictEqual(inst.ASRs.size, 0, '0 orphan ASR remain');
    assert.ok(!inst.channels.has(ck), 'per-stream marker (channel context + allocator) cleared');
    const stop = inst.emitted.find(e => e[0] === 'session-stop');
    assert.ok(stop, 'session-stop emitted exactly once');
    assert.strictEqual(inst.emitted.filter(e => e[0] === 'session-stop').length, 1);
  });

  it('a silent per-stream channel (0 ASR) still emits session-stop (lazy hole D3a)', async () => {
    const inst = makeServer();
    const session = makeSession(), channel = makeChannel();
    const ck = 'sess_chan';
    markPerStream(inst, ck, session, channel);
    // No frames -> no ASR created.
    assert.strictEqual(inst.ASRs.size, 0);

    const ret = await inst._stopAsr(session, 'chan');
    assert.strictEqual(ret, true, 'returns true even with 0 ASR');
    const stop = inst.emitted.find(e => e[0] === 'session-stop');
    assert.ok(stop, 'session-stop still emitted so the session is not stuck');
    assert.ok(!inst.channels.has(ck), 'marker cleaned up');
  });

  it('a non-per-stream channel with no ASR returns false (legacy unchanged)', async () => {
    const inst = makeServer();
    const ret = await inst._stopAsr({ id: 'sess' }, 'chan');
    assert.strictEqual(ret, false);
    assert.strictEqual(inst.emitted.length, 0);
  });

  it("the '#' key scheme never collides with a legacy channel key prefix", async () => {
    const inst = makeServer();
    // Legacy ASR under "sess_chan1"; per-stream sub-ASR under "sess_chan#..".
    // A naive startsWith("sess_chan") would falsely match "sess_chan1"; the '#'
    // boundary prevents it.
    inst.ASRs.set('sess_chan1', {});
    inst.ASRs.set('sess_chan#0', {});
    const ck = 'sess_chan';
    const subKeys = [...inst.ASRs.keys()].filter(k => k === ck || k.startsWith(`${ck}#`));
    assert.deepStrictEqual(subKeys, ['sess_chan#0']);
  });

  // #2 — a non-numeric MAX_CONCURRENT_ASR_PER_CHANNEL must default to 6 (parseInt
  // returns NaN; `subCount >= NaN` is always false so the cap would never engage
  // -> unbounded ASR -> OOM). The cap must still engage at the default.
  it('#2 a non-numeric cap env defaults to 6 and the cap still engages', async () => {
    assert.strictEqual(StreamingServer._resolveCap('not-a-number'), 6);
    assert.strictEqual(StreamingServer._resolveCap(''), 6);
    assert.strictEqual(StreamingServer._resolveCap(undefined), 6);
    assert.strictEqual(StreamingServer._resolveCap('0'), 6, 'non-positive falls back to 6');
    assert.strictEqual(StreamingServer._resolveCap('-3'), 6);
    assert.strictEqual(StreamingServer._resolveCap('4'), 4, 'a valid value is honored');

    const orig = process.env.MAX_CONCURRENT_ASR_PER_CHANNEL;
    process.env.MAX_CONCURRENT_ASR_PER_CHANNEL = 'banana';
    try {
      const inst = makeServer();
      assert.strictEqual(inst.maxAsrPerChannel, 6, 'NaN env -> cap 6, not NaN');
      const session = makeSession(), channel = makeChannel();
      markPerStream(inst, 'sess_chan', session, channel);
      const parts = [];
      for (let t = 0; t < 8; t++) parts.push({ id: `u${t}`, name: `P${t}`, tag: t });
      const wsServer = fakeWsServer(parts);
      const created = [];
      for (let t = 0; t < 6; t++) created.push(inst._getOrCreatePerStreamAsr(wsServer, 'sess', 'chan', t));
      // The 7th distinct tag must collapse onto overflow (cap engaged at 6).
      const seventh = inst._getOrCreatePerStreamAsr(wsServer, 'sess', 'chan', 6);
      assert.ok(inst.ASRs.has('sess_chan#255'), 'cap engaged -> overflow ASR created');
      assert.strictEqual(inst.ASRs.size, 7, 'bounded at cap (6) + 1 overflow');
      for (const a of created) await settle(a);
      await settle(seventh);
    } finally {
      if (orig === undefined) delete process.env.MAX_CONCURRENT_ASR_PER_CHANNEL;
      else process.env.MAX_CONCURRENT_ASR_PER_CHANNEL = orig;
    }
  });

  // #5 — a departed participant's ASR is disposed and its cap slot freed, so a
  // NEW participant speaking afterwards gets a DEDICATED ASR (not overflow).
  it('#5 leave frees the cap slot: a later new participant gets a dedicated ASR', async () => {
    const orig = process.env.MAX_CONCURRENT_ASR_PER_CHANNEL;
    process.env.MAX_CONCURRENT_ASR_PER_CHANNEL = '2';
    try {
      const inst = makeServer();
      const session = makeSession(), channel = makeChannel();
      markPerStream(inst, 'sess_chan', session, channel);
      const wsServer = fakeWsServer([
        { id: 'u0', name: 'P0', tag: 0 }, { id: 'u1', name: 'P1', tag: 1 }, { id: 'u2', name: 'P2', tag: 2 },
      ]);
      const a = inst._getOrCreatePerStreamAsr(wsServer, 'sess', 'chan', 0);
      const b = inst._getOrCreatePerStreamAsr(wsServer, 'sess', 'chan', 1);
      await settle(a); await settle(b);
      assert.strictEqual(inst.ASRs.size, 2, 'cap is full (2)');

      // Without a leave, a 3rd tag would overflow onto #255.
      // Participant 0 leaves -> dispose #0, free the slot.
      const disposed = await inst._disposePerStreamParticipant('sess', 'chan', 0);
      assert.strictEqual(disposed, true);
      assert.ok(!inst.ASRs.has('sess_chan#0'), 'departed ASR removed');
      assert.strictEqual(inst.ASRs.size, 1, 'slot freed');

      // A NEW participant (tag 2) now fits in a DEDICATED ASR, not overflow.
      const c = inst._getOrCreatePerStreamAsr(wsServer, 'sess', 'chan', 2);
      await settle(c);
      assert.ok(inst.ASRs.has('sess_chan#2'), 'new participant got a dedicated ASR');
      assert.ok(!inst.ASRs.has('sess_chan#255'), 'no overflow ASR was created');
      assert.strictEqual(c.participantName, 'P2');

      // Leaving a tag with no live ASR is a harmless no-op.
      assert.strictEqual(await inst._disposePerStreamParticipant('sess', 'chan', 9), false);
    } finally {
      if (orig === undefined) delete process.env.MAX_CONCURRENT_ASR_PER_CHANNEL;
      else process.env.MAX_CONCURRENT_ASR_PER_CHANNEL = orig;
    }
  });

  // #6 — the shared overflow ASR carries a deterministic label, never null.
  it('#6 the overflow ASR has a deterministic participant label (never blank)', async () => {
    const orig = process.env.MAX_CONCURRENT_ASR_PER_CHANNEL;
    const origName = process.env.TRANSCRIBER_OVERFLOW_SPEAKER_NAME;
    process.env.MAX_CONCURRENT_ASR_PER_CHANNEL = '1';
    delete process.env.TRANSCRIBER_OVERFLOW_SPEAKER_NAME;
    try {
      const inst = makeServer();
      const session = makeSession(), channel = makeChannel();
      markPerStream(inst, 'sess_chan', session, channel);
      const wsServer = fakeWsServer([{ id: 'u0', name: 'P0', tag: 0 }, { id: 'u1', name: 'P1', tag: 1 }]);
      const a = inst._getOrCreatePerStreamAsr(wsServer, 'sess', 'chan', 0); // fills cap (1)
      const overflow = inst._getOrCreatePerStreamAsr(wsServer, 'sess', 'chan', 1); // -> #255
      await settle(a); await settle(overflow);
      assert.ok(inst.ASRs.has('sess_chan#255'));
      assert.strictEqual(overflow.participantId, 'overflow');
      assert.strictEqual(overflow.participantName, 'Participants', 'default deterministic label');
      // A caption from the overflow ASR is labeled, never blank/null.
      const finals = [];
      overflow.on('final', t => finals.push(t));
      overflow.provider.emit('transcribed', { text: 'hi', isPrimary: true, locutor: null });
      assert.strictEqual(finals[0].locutor, 'Participants');
    } finally {
      if (orig === undefined) delete process.env.MAX_CONCURRENT_ASR_PER_CHANNEL;
      else process.env.MAX_CONCURRENT_ASR_PER_CHANNEL = orig;
      if (origName === undefined) delete process.env.TRANSCRIBER_OVERFLOW_SPEAKER_NAME;
      else process.env.TRANSCRIBER_OVERFLOW_SPEAKER_NAME = origName;
    }
  });

  it('#6 the overflow label is overridable via TRANSCRIBER_OVERFLOW_SPEAKER_NAME', async () => {
    const orig = process.env.MAX_CONCURRENT_ASR_PER_CHANNEL;
    const origName = process.env.TRANSCRIBER_OVERFLOW_SPEAKER_NAME;
    process.env.MAX_CONCURRENT_ASR_PER_CHANNEL = '1';
    process.env.TRANSCRIBER_OVERFLOW_SPEAKER_NAME = 'Autres participants';
    try {
      const inst = makeServer();
      const session = makeSession(), channel = makeChannel();
      markPerStream(inst, 'sess_chan', session, channel);
      const wsServer = fakeWsServer([{ id: 'u0', name: 'P0', tag: 0 }, { id: 'u1', name: 'P1', tag: 1 }]);
      const a = inst._getOrCreatePerStreamAsr(wsServer, 'sess', 'chan', 0);
      const overflow = inst._getOrCreatePerStreamAsr(wsServer, 'sess', 'chan', 1);
      await settle(a); await settle(overflow);
      assert.strictEqual(overflow.participantName, 'Autres participants');
    } finally {
      if (orig === undefined) delete process.env.MAX_CONCURRENT_ASR_PER_CHANNEL;
      else process.env.MAX_CONCURRENT_ASR_PER_CHANNEL = orig;
      if (origName === undefined) delete process.env.TRANSCRIBER_OVERFLOW_SPEAKER_NAME;
      else process.env.TRANSCRIBER_OVERFLOW_SPEAKER_NAME = origName;
    }
  });

  // #7 — a live sub-ASR rename updates its name and subsequent captions carry it.
  it('#7 mid-call rename updates the live ASR; the next final carries the new name', async () => {
    const inst = makeServer();
    const session = makeSession(), channel = makeChannel();
    markPerStream(inst, 'sess_chan', session, channel);
    const wsServer = fakeWsServer([{ id: 'u0', name: 'Alice', tag: 0 }]);
    const a = inst._getOrCreatePerStreamAsr(wsServer, 'sess', 'chan', 0);
    await settle(a);
    const finals = [];
    a.on('final', t => finals.push(t.locutor));
    a.provider.emit('transcribed', { text: 'before', isPrimary: true });
    assert.strictEqual(finals[0], 'Alice');

    inst._renamePerStreamParticipant('sess', 'chan', 0, 'Alice Cooper');
    assert.strictEqual(a.participantName, 'Alice Cooper');
    a.provider.emit('transcribed', { text: 'after', isPrimary: true });
    assert.strictEqual(finals[1], 'Alice Cooper', 'subsequent caption carries the new name');

    // Renaming a tag with no live ASR is a harmless no-op.
    assert.doesNotThrow(() => inst._renamePerStreamParticipant('sess', 'chan', 9, 'Nobody'));
  });

  // #8 — a participant speaking for the FIRST time during a pause must not leak:
  // the lazily-created ASR is paused on creation; resume re-enables it.
  it('#8 an ASR created during a pause is paused; resume re-enables it', async () => {
    const inst = makeServer();
    const session = makeSession(), channel = makeChannel();
    markPerStream(inst, 'sess_chan', session, channel);
    const wsServer = fakeWsServer([{ id: 'u0', name: 'Alice', tag: 0 }, { id: 'u1', name: 'Bob', tag: 1 }]);

    // Pause the session BEFORE any ASR exists for the new speaker.
    await inst.pauseSession('sess');
    assert.strictEqual(inst.channels.get('sess_chan').paused, true);

    // A new tag speaks during the pause -> created paused, transcribe is dropped.
    const a = inst._getOrCreatePerStreamAsr(wsServer, 'sess', 'chan', 0);
    await settle(a);
    assert.strictEqual(a.paused, true, 'lazily-created ASR is paused, not leaking');
    const before = a.provider.transcribeCallCount;
    a.transcribe(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
    assert.strictEqual(a.provider.transcribeCallCount, before, 'paused ASR drops audio');

    // Resume re-enables every ASR of the session, including the lazy one.
    await inst.resumeSession('sess');
    await settle(a);
    assert.strictEqual(inst.channels.get('sess_chan').paused, false);
    assert.strictEqual(a.paused, false, 'resume re-enabled the ASR');
  });

  // #9 — stopping a channel with N sub-ASR stores EXACTLY ONE blank end-of-stream
  // marker, not N (each streamStopped() would emit one empty-text final).
  it('#9 channel stop emits exactly ONE empty-text end-of-stream marker', async () => {
    const inst = makeServer();
    const session = makeSession(), channel = makeChannel();
    markPerStream(inst, 'sess_chan', session, channel);
    const wsServer = fakeWsServer([
      { id: 'u0', name: 'P0', tag: 0 }, { id: 'u1', name: 'P1', tag: 1 }, { id: 'u2', name: 'P2', tag: 2 },
    ]);
    const a = inst._getOrCreatePerStreamAsr(wsServer, 'sess', 'chan', 0);
    const b = inst._getOrCreatePerStreamAsr(wsServer, 'sess', 'chan', 1);
    const c = inst._getOrCreatePerStreamAsr(wsServer, 'sess', 'chan', 2);
    await settle(a); await settle(b); await settle(c);
    assert.strictEqual(inst.ASRs.size, 3);

    await inst._stopAsr(session, 'chan');
    // The _wireAsr 'final' listener forwards every ASR final to inst.emit('final', ...).
    const blankFinals = inst.emitted.filter(e => e[0] === 'final' && e[1] && e[1].text === '');
    assert.strictEqual(blankFinals.length, 1, 'exactly ONE blank marker for the whole channel');
    assert.strictEqual(inst.ASRs.size, 0, '0 orphans');
  });
});
