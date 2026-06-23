const assert = require('assert');
const { describe, it, beforeEach } = require('mocha');
const MultiplexedWebsocketServer = require('../components/StreamingServer/websocket/WebsocketServer');
const SpeakerTracker = require('../components/StreamingServer/SpeakerTracker');

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
