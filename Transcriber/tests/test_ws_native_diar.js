const assert = require('assert');
const { describe, it, beforeEach, afterEach } = require('mocha');
const MultiplexedWebsocketServer = require('../components/StreamingServer/websocket/WebsocketServer');
const SpeakerTracker = require('../components/StreamingServer/SpeakerTracker');
// Same `ws` module instance the WebsocketServer uses; start()/stop() tests
// monkey-patch WS.Server so no real TCP port is opened.
const WS = require('ws');
// Same singleton logger instance the WebsocketServer requires; stub its methods
// to assert the rejected-control-message log paths fire.
const logger = require('../logger');

// The native-diarization PCM callback must split inline JSON control messages
// (speakerChanged / participant) from binary audio robustly: a PCM frame that
// merely starts with the bytes 0x7B 0x22 ('{"') but is not valid JSON must be
// treated as audio (never dropped).
describe('WebsocketServer native-diarization control routing', () => {
  let server, fd, tracker;
  beforeEach(() => {
    server = new MultiplexedWebsocketServer({});
    tracker = new SpeakerTracker();
    fd = { session: { id: 's' }, channel: { id: 'c' }, diarizationMode: 'native' };
    server.speakerTrackers.set('s_c', tracker);
  });

  it('routes a speakerChanged control message to the tracker', () => {
    const msg = Buffer.from(JSON.stringify({ type: 'speakerChanged', position: 0, speaker: { id: 'u1', name: 'Alice' } }));
    assert.equal(server.handleControlMessage(fd, msg), true);
    assert.equal(tracker.currentSpeaker.id, 'u1');
  });

  it('routes a participant join/leave control message to the tracker', () => {
    const join = Buffer.from(JSON.stringify({ type: 'participant', action: 'join', participant: { id: 'u1', name: 'Alice' } }));
    assert.equal(server.handleControlMessage(fd, join), true);
    assert.equal(tracker.participants.size, 1);
  });

  it('treats a PCM frame starting with 0x7B22 but invalid JSON as audio (not dropped)', () => {
    // First 16-bit sample = 0x227B (little-endian bytes 0x7B,0x22) then random PCM.
    const pcm = Buffer.from([0x7B, 0x22, 0x10, 0xF0, 0x55, 0xAA]);
    assert.equal(server.handleControlMessage(fd, pcm), false);
  });

  it('treats ordinary PCM as audio', () => {
    const pcm = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    assert.equal(server.handleControlMessage(fd, pcm), false);
  });

  it('never consumes control messages when diarizationMode is not native', () => {
    fd.diarizationMode = 'asr';
    const msg = Buffer.from(JSON.stringify({ type: 'speakerChanged', position: 0, speaker: { id: 'u1', name: 'Alice' } }));
    assert.equal(server.handleControlMessage(fd, msg), false);
  });

  it('getSpeakerTracker returns the channel tracker, null otherwise', () => {
    assert.equal(server.getSpeakerTracker('s', 'c'), tracker);
    assert.equal(server.getSpeakerTracker('x', 'y'), null);
  });
});

// A well-formed JSON control message that cannot be applied (no tracker / unknown
// type) must NOT be dropped silently — it warns; a '{"'-prefixed frame that fails
// to parse falls through to PCM but is logged at debug.
describe('WebsocketServer rejected control-message logging', () => {
  let server, fd, warns, debugs, origWarn, origDebug;
  beforeEach(() => {
    server = new MultiplexedWebsocketServer({});
    fd = { session: { id: 's' }, channel: { id: 'c' }, diarizationMode: 'native' };
    warns = []; debugs = [];
    origWarn = logger.warn; origDebug = logger.debug;
    logger.warn = (msg) => warns.push(msg);
    logger.debug = (msg) => debugs.push(msg);
  });
  afterEach(() => { logger.warn = origWarn; logger.debug = origDebug; });

  it('warns and drops a well-formed control message when no tracker exists', () => {
    // No tracker registered for s_c.
    const msg = Buffer.from(JSON.stringify({ type: 'speakerChanged', speaker: { id: 'u1' } }));
    assert.equal(server.handleControlMessage(fd, msg), false);
    assert.equal(warns.length, 1);
    assert.ok(/no SpeakerTracker/.test(warns[0]));
  });

  it('warns and drops a control message with an unknown type', () => {
    server.speakerTrackers.set('s_c', new SpeakerTracker());
    const msg = Buffer.from(JSON.stringify({ type: 'bogus' }));
    assert.equal(server.handleControlMessage(fd, msg), false);
    assert.equal(warns.length, 1);
    assert.ok(/unknown type 'bogus'/.test(warns[0]));
  });

  it('logs at debug (not warn) when a {"-prefixed frame fails to parse, falling through to PCM', () => {
    const pcm = Buffer.from([0x7B, 0x22, 0x10, 0xF0, 0x55, 0xAA]);
    assert.equal(server.handleControlMessage(fd, pcm), false);
    assert.equal(warns.length, 0, 'parse failure must not warn (could be coincidental PCM)');
    assert.equal(debugs.length, 1);
  });

  it('does not log for a successfully routed control message', () => {
    server.speakerTrackers.set('s_c', new SpeakerTracker());
    const msg = Buffer.from(JSON.stringify({ type: 'speakerChanged', speaker: { id: 'u1' } }));
    assert.equal(server.handleControlMessage(fd, msg), true);
    assert.equal(warns.length, 0);
    assert.equal(debugs.length, 0);
  });
});

// The speakerTrackers Map must not leak: an init that creates the tracker but
// then fails (initPcm/initWorker throws or returns null) has to remove it, and
// a periodic reaper has to drop any tracker whose channel is no longer running.
describe('WebsocketServer speakerTrackers leak prevention', () => {
  let server, ws;
  beforeEach(() => {
    server = new MultiplexedWebsocketServer({});
    // Minimal ws stub: handleInitMessage only calls ws.send / ws.on.
    ws = { send: () => {}, on: () => {} };
  });

  function nativeInitMessage() {
    return Buffer.from(JSON.stringify({
      type: 'init',
      encoding: 'pcm',
      sampleRate: 16000,
      diarizationMode: 'native',
      participants: [{ id: 'u1', name: 'Alice' }],
    }));
  }

  it('removes the tracker when init throws after tracker creation', () => {
    const fd = { session: { id: 's1' }, channel: { id: 'c1' } };
    // Force the post-set init step to fail.
    server.initPcm = () => { throw new Error('boom'); };
    const cb = server.handleInitMessage(ws, nativeInitMessage(), fd);
    assert.equal(cb, null);
    assert.equal(server.speakerTrackers.has('s1_c1'), false, 'tracker must be deleted on init failure');
  });

  it('removes the tracker when init returns null after tracker creation', () => {
    const fd = { session: { id: 's2' }, channel: { id: 'c2' } };
    server.initPcm = () => null;
    const cb = server.handleInitMessage(ws, nativeInitMessage(), fd);
    assert.equal(cb, null);
    assert.equal(server.speakerTrackers.has('s2_c2'), false, 'tracker must be deleted on null init');
  });

  it('keeps the tracker when init succeeds', () => {
    const fd = { session: { id: 's3' }, channel: { id: 'c3' } };
    server.initPcm = () => (() => {});
    const cb = server.handleInitMessage(ws, nativeInitMessage(), fd);
    assert.equal(typeof cb, 'function');
    assert.equal(server.speakerTrackers.has('s3_c3'), true);
  });

  it('reaper drops orphan trackers and spares running ones', () => {
    server.speakerTrackers.set('sX_42', new SpeakerTracker());   // orphan: no running channel
    server.speakerTrackers.set('sY_99', new SpeakerTracker());   // running channel
    server.runningChannels['99'] = {};
    server.reapOrphanTrackers();
    assert.equal(server.speakerTrackers.has('sX_42'), false, 'orphan must be reaped');
    assert.equal(server.speakerTrackers.has('sY_99'), true, 'running channel tracker must survive');
  });

  it('startReaper / stopReaper are idempotent and clear the timer', () => {
    server.startReaper();
    assert.notEqual(server.reaperInterval, null);
    const first = server.reaperInterval;
    server.startReaper(); // idempotent: must not replace the timer
    assert.equal(server.reaperInterval, first);
    server.stopReaper();
    assert.equal(server.reaperInterval, null);
    server.stopReaper(); // safe to call twice
    assert.equal(server.reaperInterval, null);
  });
});

// handleInitMessage error/ack paths and tracker construction. The ws stub
// captures every ws.send payload so the exact protocol reply can be asserted.
describe('WebsocketServer handleInitMessage protocol replies', () => {
  let server, ws, sent;
  beforeEach(() => {
    server = new MultiplexedWebsocketServer({});
    sent = [];
    ws = { send: (m) => sent.push(JSON.parse(m)), on: () => {} };
  });

  function initMessage(extra) {
    return Buffer.from(JSON.stringify(Object.assign({
      type: 'init', encoding: 'pcm', sampleRate: 16000,
    }, extra)));
  }

  it('sends an error reply on JSON parse failure and returns null', () => {
    const fd = { session: { id: 's' }, channel: { id: 'c' } };
    const cb = server.handleInitMessage(ws, Buffer.from('not json {'), fd);
    assert.equal(cb, null);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'error');
    assert.ok(/Invalid JSON init message/.test(sent[0].message));
  });

  it('sends an error reply when the message type is not init', () => {
    const fd = { session: { id: 's' }, channel: { id: 'c' } };
    const cb = server.handleInitMessage(ws, Buffer.from(JSON.stringify({ type: 'hello' })), fd);
    assert.equal(cb, null);
    assert.equal(sent[0].type, 'error');
    assert.ok(/must be 'init'/.test(sent[0].message));
  });

  it('sends an error reply when pcm sampleRate is not 16000', () => {
    const fd = { session: { id: 's' }, channel: { id: 'c' } };
    const cb = server.handleInitMessage(ws, initMessage({ sampleRate: 8000 }), fd);
    assert.equal(cb, null);
    assert.equal(sent[0].type, 'error');
    assert.ok(/Invalid sample rate: 8000/.test(sent[0].message));
    assert.ok(/Only 16000 is accepted/.test(sent[0].message));
  });

  it('sends an error reply before tracker deletion when initPcm throws', () => {
    const fd = { session: { id: 's' }, channel: { id: 'c' } };
    server.initPcm = () => { throw new Error('boom'); };
    const cb = server.handleInitMessage(ws, initMessage({ diarizationMode: 'native' }), fd);
    assert.equal(cb, null);
    assert.equal(sent[0].type, 'error');
    assert.ok(/Init failed: Error: boom/.test(sent[0].message));
    assert.equal(server.speakerTrackers.has('s_c'), false, 'tracker dropped after the error reply');
  });

  it('sends an ack reply and returns the callback on a successful init', () => {
    const fd = { session: { id: 's' }, channel: { id: 'c' } };
    server.initPcm = () => (() => {});
    const cb = server.handleInitMessage(ws, initMessage(), fd);
    assert.equal(typeof cb, 'function');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'ack');
    assert.equal(sent[0].message, 'Init done');
  });
});

// Tracker construction from the init message: asr mode creates no tracker;
// native mode seeds the tracker from initMessage.participants.
describe('WebsocketServer handleInitMessage tracker construction', () => {
  let server, ws;
  beforeEach(() => {
    server = new MultiplexedWebsocketServer({});
    ws = { send: () => {}, on: () => {} };
    server.initPcm = () => (() => {});
  });

  function nativeInit(participants) {
    const body = { type: 'init', encoding: 'pcm', sampleRate: 16000, diarizationMode: 'native' };
    if (participants !== undefined) body.participants = participants;
    return Buffer.from(JSON.stringify(body));
  }

  it('creates no SpeakerTracker when diarizationMode is asr', () => {
    const fd = { session: { id: 's' }, channel: { id: 'c' } };
    const cb = server.handleInitMessage(ws, Buffer.from(JSON.stringify({
      type: 'init', encoding: 'pcm', sampleRate: 16000, diarizationMode: 'asr',
    })), fd);
    assert.equal(typeof cb, 'function');
    assert.equal(server.speakerTrackers.has('s_c'), false);
    assert.equal(server.getSpeakerTracker('s', 'c'), null);
  });

  it('defaults to asr (no tracker) when diarizationMode is omitted', () => {
    const fd = { session: { id: 's' }, channel: { id: 'c' } };
    server.handleInitMessage(ws, Buffer.from(JSON.stringify({
      type: 'init', encoding: 'pcm', sampleRate: 16000,
    })), fd);
    assert.equal(server.speakerTrackers.has('s_c'), false);
  });

  it('creates a tracker with zero participants when participants is undefined', () => {
    const fd = { session: { id: 's' }, channel: { id: 'c' } };
    server.handleInitMessage(ws, nativeInit(undefined), fd);
    const tracker = server.getSpeakerTracker('s', 'c');
    assert.notEqual(tracker, null);
    assert.equal(tracker.participants.size, 0);
  });

  it('creates a tracker with zero participants when participants is an empty array', () => {
    const fd = { session: { id: 's' }, channel: { id: 'c' } };
    server.handleInitMessage(ws, nativeInit([]), fd);
    const tracker = server.getSpeakerTracker('s', 'c');
    assert.notEqual(tracker, null);
    assert.equal(tracker.participants.size, 0);
  });

  it('adds every participant from the init message to the tracker', () => {
    const fd = { session: { id: 's' }, channel: { id: 'c' } };
    server.handleInitMessage(ws, nativeInit([
      { id: 'u1', name: 'Alice' },
      { id: 'u2', name: 'Bob' },
      { id: 'u3', name: 'Carol' },
    ]), fd);
    const tracker = server.getSpeakerTracker('s', 'c');
    assert.equal(tracker.participants.size, 3);
    assert.ok(tracker.participants.has('u1'));
    assert.ok(tracker.participants.has('u2'));
    assert.ok(tracker.participants.has('u3'));
  });
});

// handleControlMessage boundary and missing-field branches.
describe('WebsocketServer handleControlMessage boundaries', () => {
  let server, fd;
  beforeEach(() => {
    server = new MultiplexedWebsocketServer({});
    fd = { session: { id: 's' }, channel: { id: 'c' }, diarizationMode: 'native' };
    server.speakerTrackers.set('s_c', new SpeakerTracker());
  });

  it('returns false for a zero-length buffer (no parse attempted)', () => {
    assert.equal(server.handleControlMessage(fd, Buffer.alloc(0)), false);
  });

  it('returns false for a one-byte buffer (below the 2-byte prefix check)', () => {
    assert.equal(server.handleControlMessage(fd, Buffer.from([0x7B])), false);
  });

  it('returns false when the message is not a Buffer', () => {
    assert.equal(server.handleControlMessage(fd, '{"type":"speakerChanged"}'), false);
  });

  it('routes a speakerChanged with no speaker field to addSpeakerChange (silence)', () => {
    const tracker = server.getSpeakerTracker('s', 'c');
    let received;
    tracker.addSpeakerChange = (d) => { received = d; };
    const msg = Buffer.from(JSON.stringify({ type: 'speakerChanged' }));
    assert.equal(server.handleControlMessage(fd, msg), true);
    assert.deepEqual(received, { type: 'speakerChanged' });
  });

  it('routes a participant with no participant field to updateParticipant', () => {
    const tracker = server.getSpeakerTracker('s', 'c');
    let received;
    tracker.updateParticipant = (d) => { received = d; };
    const msg = Buffer.from(JSON.stringify({ type: 'participant', action: 'join' }));
    assert.equal(server.handleControlMessage(fd, msg), true);
    assert.deepEqual(received, { type: 'participant', action: 'join' });
  });
});

// initPcm() callback wiring: every frame goes through handleControlMessage, and
// audio (non-control) frames are emitted as 'data' with session/channel ids.
describe('WebsocketServer initPcm callback routing', () => {
  let server, ws, fd;
  beforeEach(() => {
    server = new MultiplexedWebsocketServer({});
    ws = { send: () => {}, on: () => {}, close: () => {} };
    fd = { session: { id: 's' }, channel: { id: 'c' }, diarizationMode: 'native' };
    server.speakerTrackers.set('s_c', new SpeakerTracker());
  });

  it('calls handleControlMessage for each frame and emits audio that is not a control message', () => {
    const seen = [];
    let origHandle = server.handleControlMessage.bind(server);
    server.handleControlMessage = (f, m) => { seen.push(m); return origHandle(f, m); };
    const dataEvents = [];
    server.on('data', (buf, sid, cid) => dataEvents.push({ buf, sid, cid }));

    const cb = server.initPcm(ws, fd);
    const pcm = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    cb(pcm);

    assert.equal(seen.length, 1, 'every frame is checked as a control message');
    assert.equal(dataEvents.length, 1, 'non-control frame is emitted as audio');
    assert.equal(dataEvents[0].sid, 's');
    assert.equal(dataEvents[0].cid, 'c');
    assert.ok(dataEvents[0].buf.equals(pcm));
  });

  it('does not emit audio when the frame is consumed as a control message', () => {
    const dataEvents = [];
    server.on('data', () => dataEvents.push(1));
    const cb = server.initPcm(ws, fd);
    const control = Buffer.from(JSON.stringify({ type: 'speakerChanged', speaker: { id: 'u1', name: 'Alice' } }));
    cb(control);
    assert.equal(dataEvents.length, 0, 'control messages are not forwarded as audio');
  });
});

// cleanupWebsocket tracker deletion and getSpeakerTracker channel isolation.
describe('WebsocketServer cleanupWebsocket and tracker isolation', () => {
  let server;
  beforeEach(() => {
    server = new MultiplexedWebsocketServer({});
  });

  it('deletes the SpeakerTracker keyed by sessionId_channelId when fd is provided', () => {
    const fd = { session: { id: 's' }, channel: { id: 'c' } };
    server.speakerTrackers.set('s_c', new SpeakerTracker());
    server.cleanupWebsocket(null, fd, null);
    assert.equal(server.speakerTrackers.has('s_c'), false);
  });

  it('does not touch any tracker when fd is null', () => {
    server.speakerTrackers.set('s_c', new SpeakerTracker());
    server.cleanupWebsocket(null, null, null);
    assert.equal(server.speakerTrackers.has('s_c'), true);
  });

  it('distinguishes trackers for the same session on different channels', () => {
    const t1 = new SpeakerTracker();
    const t2 = new SpeakerTracker();
    server.speakerTrackers.set('s_c1', t1);
    server.speakerTrackers.set('s_c2', t2);
    assert.equal(server.getSpeakerTracker('s', 'c1'), t1);
    assert.equal(server.getSpeakerTracker('s', 'c2'), t2);
    // Cleaning up one channel leaves the sibling intact.
    server.cleanupWebsocket(null, { session: { id: 's' }, channel: { id: 'c1' } }, null);
    assert.equal(server.getSpeakerTracker('s', 'c1'), null);
    assert.equal(server.getSpeakerTracker('s', 'c2'), t2);
  });
});

// Reaper key parsing relies on the LAST underscore being the session/channel
// separator; ids that themselves contain underscores exercise that boundary.
describe('WebsocketServer reaper key parsing', () => {
  let server, infos, origInfo;
  beforeEach(() => {
    server = new MultiplexedWebsocketServer({});
    infos = [];
    origInfo = logger.info;
    logger.info = (m) => infos.push(m);
  });
  afterEach(() => { logger.info = origInfo; });

  it('reaps an orphan whose key has underscores in both session and channel id', () => {
    // key = `${sessionId}_${channelId}`; channelId is everything after the LAST '_'.
    // With sessionId='session_id_1' and channelId='channel_id_2' the channelId
    // segment the reaper extracts is '2'. It is an orphan (no runningChannels['2']).
    server.speakerTrackers.set('session_id_1_channel_id_2', new SpeakerTracker());
    server.reapOrphanTrackers();
    assert.equal(server.speakerTrackers.has('session_id_1_channel_id_2'), false);
  });

  it('spares a tracker whose last-underscore segment matches a running channel', () => {
    server.speakerTrackers.set('session_id_1_channel_id_2', new SpeakerTracker());
    server.runningChannels['2'] = {};
    server.reapOrphanTrackers();
    assert.equal(server.speakerTrackers.has('session_id_1_channel_id_2'), true);
  });

  it('logs an info line naming the reaped key', () => {
    server.speakerTrackers.set('sX_42', new SpeakerTracker());
    server.reapOrphanTrackers();
    assert.equal(infos.length, 1);
    assert.ok(/Reaping orphan speaker tracker/.test(infos[0]));
    assert.ok(/key sX_42/.test(infos[0]));
  });
});

// startReaper unref support: the interval handle must be unref'd when the
// runtime supports it so the reaper never keeps the event loop alive.
describe('WebsocketServer startReaper unref', () => {
  it('calls unref() on the interval when the handle supports it', () => {
    const server = new MultiplexedWebsocketServer({});
    server.startReaper();
    try {
      // Node timers expose unref; calling it must be safe and idempotent.
      assert.equal(typeof server.reaperInterval.unref, 'function');
      assert.doesNotThrow(() => server.reaperInterval.unref());
    } finally {
      server.stopReaper();
    }
  });

  it('does not throw when the interval handle has no unref (browser-style)', () => {
    const server = new MultiplexedWebsocketServer({});
    const realSetInterval = global.setInterval;
    // Simulate a runtime whose setInterval returns a plain numeric id (no unref).
    global.setInterval = () => 123;
    try {
      assert.doesNotThrow(() => server.startReaper());
      assert.equal(server.reaperInterval, 123);
    } finally {
      global.setInterval = realSetInterval;
      server.reaperInterval = null; // numeric id: nothing to clear
    }
  });
});

// start()/stop() lifecycle. WebSocket.Server is monkey-patched so no real TCP
// port is opened; start() must wire the reaper and the isRunning flag.
describe('WebsocketServer start/stop lifecycle', () => {
  let server, OrigServer;
  beforeEach(() => {
    server = new MultiplexedWebsocketServer({});
    OrigServer = WS.Server;
  });
  afterEach(() => { WS.Server = OrigServer; });

  it('start() creates the WebSocket.Server, arms the reaper and sets isRunning', async () => {
    let constructed = null;
    WS.Server = function FakeServer(opts) { constructed = opts; this.on = () => {}; this.close = () => {}; };
    await server.start();
    try {
      assert.notEqual(constructed, null, 'WebSocket.Server was constructed');
      assert.equal(server.isRunning, true);
      assert.notEqual(server.reaperInterval, null, 'startReaper() armed the reaper');
    } finally {
      server.stopReaper();
    }
  });

  it('start() is a no-op when already running', async () => {
    let count = 0;
    WS.Server = function FakeServer() { count++; this.on = () => {}; this.close = () => {}; };
    await server.start();
    await server.start(); // already running -> must not construct a second server
    server.stopReaper();
    assert.equal(count, 1);
  });

  it('stop() closes the server, disarms the reaper and clears isRunning', async () => {
    let closed = false;
    WS.Server = function FakeServer() { this.on = () => {}; this.close = () => { closed = true; }; };
    await server.start();
    await server.stop();
    assert.equal(closed, true, 'wss.close() was invoked');
    assert.equal(server.isRunning, false);
    assert.equal(server.wss, null);
    assert.equal(server.reaperInterval, null, 'stopReaper() cleared the timer');
  });
});
