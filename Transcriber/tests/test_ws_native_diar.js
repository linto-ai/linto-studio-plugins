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
