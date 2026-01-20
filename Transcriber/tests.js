const assert = require('assert');
const { describe, it } = require('mocha');
const { CircularBuffer } = require("live-srt-lib");
const SpeakerTracker = require('./components/StreamingServer/SpeakerTracker');

process.env.SAMPLE_RATE = 1;
process.env.BYTES_PER_SAMPLE = 1;
process.env.MAX_AUDIO_BUFFER = 6;


describe('CircularBuffer', () => {
  describe('#add()', () => {
    it('should add packets to the buffer', () => {
      const buffer = new CircularBuffer();
      const packet1 = new Uint8Array([1, 2, 3]);
      const packet2 = new Uint8Array([4, 5, 6]);
      buffer.add(packet1);
      buffer.add(packet2);
      assert.deepEqual(buffer.getAudioBuffer(), new Uint8Array([1, 2, 3, 4, 5, 6]));
    });

    it('should wrap around when the buffer is full', () => {
      const buffer = new CircularBuffer();
      const packet1 = new Uint8Array([1, 2, 3]);
      const packet2 = new Uint8Array([4, 5, 6]);
      const packet3 = new Uint8Array([7, 8, 9]);
      buffer.add(packet1);
      buffer.add(packet2);
      buffer.add(packet3);
      assert.deepEqual(buffer.getAudioBuffer(), new Uint8Array([7, 8, 9]));
    });
  });

  describe('#getAudioBuffer()', () => {
    it('should return the audio buffer', () => {
      const buffer = new CircularBuffer();
      const packet1 = new Uint8Array([1, 2, 3]);
      const packet2 = new Uint8Array([4, 5, 6]);
      buffer.add(packet1);
      buffer.add(packet2);
      assert.deepEqual(buffer.getAudioBuffer(), new Uint8Array([1, 2, 3, 4, 5, 6]));
    });
  });

  describe('#flush()', () => {
    it('should reset the pointer', () => {
      const buffer = new CircularBuffer();
      const packet1 = new Uint8Array([1, 2, 3]);
      buffer.add(packet1);
      buffer.flush();
      assert.equal(buffer.pointer, 0);
    });
  });
});

describe('SpeakerTracker', () => {
  describe('#updateParticipant()', () => {
    it('should track participants joining', () => {
      const tracker = new SpeakerTracker();
      tracker.updateParticipant({ action: 'join', participant: { id: 'u1', name: 'Alice' } });
      assert.equal(tracker.getParticipantName('u1'), 'Alice');
    });

    it('should handle participants leaving', () => {
      const tracker = new SpeakerTracker();
      tracker.updateParticipant({ action: 'join', participant: { id: 'u1', name: 'Alice' } });
      tracker.updateParticipant({ action: 'leave', participant: { id: 'u1' } });
      // Fallback to ID when participant not found
      assert.equal(tracker.getParticipantName('u1'), 'u1');
    });
  });

  describe('#addSpeakerEvent()', () => {
    it('should store speaker events', () => {
      const tracker = new SpeakerTracker();
      const now = Date.now();
      tracker.addSpeakerEvent({ timestamp: now, speakers: [{ id: 'u1', energy: 1000 }] });
      assert.equal(tracker.hasSpeakerEvents(), true);
    });
  });

  describe('#getSpeakerForTimestamp()', () => {
    it('should find dominant speaker for timestamp', () => {
      const tracker = new SpeakerTracker();
      const now = Date.now();

      tracker.addSpeakerEvent({ timestamp: now, speakers: [{ id: 'u1', energy: 1000 }] });
      tracker.addSpeakerEvent({ timestamp: now + 20, speakers: [{ id: 'u1', energy: 800 }, { id: 'u2', energy: 200 }] });
      tracker.addSpeakerEvent({ timestamp: now + 40, speakers: [{ id: 'u2', energy: 1500 }] });

      // u1 dominates at the start
      assert.equal(tracker.getSpeakerForTimestamp(now, 30), 'u1');
    });

    it('should return null when no events in range', () => {
      const tracker = new SpeakerTracker();
      const now = Date.now();
      tracker.addSpeakerEvent({ timestamp: now, speakers: [{ id: 'u1', energy: 1000 }] });

      // Search 10 seconds later - no events
      assert.equal(tracker.getSpeakerForTimestamp(now + 10000, 100), null);
    });

    it('should select speaker with highest cumulative energy', () => {
      const tracker = new SpeakerTracker();
      const now = Date.now();

      // u2 has more total energy over the period
      tracker.addSpeakerEvent({ timestamp: now, speakers: [{ id: 'u1', energy: 500 }] });
      tracker.addSpeakerEvent({ timestamp: now + 20, speakers: [{ id: 'u2', energy: 600 }] });
      tracker.addSpeakerEvent({ timestamp: now + 40, speakers: [{ id: 'u2', energy: 600 }] });

      // u2: 1200 total, u1: 500 total -> u2 wins
      assert.equal(tracker.getSpeakerForTimestamp(now, 100), 'u2');
    });
  });

  describe('#clear()', () => {
    it('should clear all data', () => {
      const tracker = new SpeakerTracker();
      tracker.updateParticipant({ action: 'join', participant: { id: 'u1', name: 'Alice' } });
      tracker.addSpeakerEvent({ timestamp: Date.now(), speakers: [{ id: 'u1', energy: 1000 }] });

      tracker.clear();

      assert.equal(tracker.hasSpeakerEvents(), false);
      assert.equal(tracker.getParticipantName('u1'), 'u1'); // Falls back to ID
    });
  });

  describe('#getStats()', () => {
    it('should return correct stats', () => {
      const tracker = new SpeakerTracker();
      tracker.updateParticipant({ action: 'join', participant: { id: 'u1', name: 'Alice' } });
      tracker.updateParticipant({ action: 'join', participant: { id: 'u2', name: 'Bob' } });
      tracker.addSpeakerEvent({ timestamp: Date.now(), speakers: [{ id: 'u1', energy: 1000 }] });

      const stats = tracker.getStats();
      assert.equal(stats.participantCount, 2);
      assert.equal(stats.eventCount, 1);
    });
  });
});