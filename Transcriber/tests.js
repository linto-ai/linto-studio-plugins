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

  describe('#addSpeakerChange()', () => {
    it('should update currentSpeaker', () => {
      const tracker = new SpeakerTracker();
      tracker.addSpeakerChange({ position: 100, speaker: { id: 'u1', name: 'Alice' } });
      assert.deepEqual(tracker.currentSpeaker, { id: 'u1', name: 'Alice' });
    });

    it('should set currentSpeaker to null for silence', () => {
      const tracker = new SpeakerTracker();
      tracker.addSpeakerChange({ position: 100, speaker: { id: 'u1', name: 'Alice' } });
      tracker.addSpeakerChange({ position: 200, speaker: null });
      assert.equal(tracker.currentSpeaker, null);
    });
  });

  describe('#assignSpeakerToSegment()', () => {
    it('should freeze speaker at first call for a segmentId', () => {
      const tracker = new SpeakerTracker();
      tracker.addSpeakerChange({ position: 100, speaker: { id: 'u1', name: 'Alice' } });
      tracker.assignSpeakerToSegment(1);
      assert.deepEqual(tracker.getSpeakerForSegment(1), { id: 'u1', name: 'Alice' });
    });

    it('should not change speaker on subsequent calls for same segmentId', () => {
      const tracker = new SpeakerTracker();
      tracker.addSpeakerChange({ position: 100, speaker: { id: 'u1', name: 'Alice' } });
      tracker.assignSpeakerToSegment(1);

      // Speaker changes to Bob, but segment 1 should stay Alice
      tracker.addSpeakerChange({ position: 200, speaker: { id: 'u2', name: 'Bob' } });
      tracker.assignSpeakerToSegment(1);
      assert.deepEqual(tracker.getSpeakerForSegment(1), { id: 'u1', name: 'Alice' });
    });

    it('should assign different speakers to different segments', () => {
      const tracker = new SpeakerTracker();
      tracker.addSpeakerChange({ position: 100, speaker: { id: 'u1', name: 'Alice' } });
      tracker.assignSpeakerToSegment(1);

      tracker.addSpeakerChange({ position: 500, speaker: { id: 'u2', name: 'Bob' } });
      tracker.assignSpeakerToSegment(2);

      assert.deepEqual(tracker.getSpeakerForSegment(1), { id: 'u1', name: 'Alice' });
      assert.deepEqual(tracker.getSpeakerForSegment(2), { id: 'u2', name: 'Bob' });
    });
  });

  describe('#getSpeakerForSegment()', () => {
    it('should return null for unknown segmentId', () => {
      const tracker = new SpeakerTracker();
      assert.equal(tracker.getSpeakerForSegment(99), null);
    });
  });

  describe('#clearSegment()', () => {
    it('should remove segment from map', () => {
      const tracker = new SpeakerTracker();
      tracker.addSpeakerChange({ position: 100, speaker: { id: 'u1', name: 'Alice' } });
      tracker.assignSpeakerToSegment(1);
      tracker.clearSegment(1);
      assert.equal(tracker.getSpeakerForSegment(1), null);
    });
  });

  describe('#clear()', () => {
    it('should clear all data', () => {
      const tracker = new SpeakerTracker();
      tracker.updateParticipant({ action: 'join', participant: { id: 'u1', name: 'Alice' } });
      tracker.addSpeakerChange({ position: 100, speaker: { id: 'u1', name: 'Alice' } });
      tracker.assignSpeakerToSegment(1);

      tracker.clear();

      assert.equal(tracker.currentSpeaker, null);
      assert.equal(tracker.getSpeakerForSegment(1), null);
      assert.equal(tracker.getParticipantName('u1'), 'u1');
    });
  });

  describe('#getStats()', () => {
    it('should return correct stats', () => {
      const tracker = new SpeakerTracker();
      tracker.updateParticipant({ action: 'join', participant: { id: 'u1', name: 'Alice' } });
      tracker.updateParticipant({ action: 'join', participant: { id: 'u2', name: 'Bob' } });
      tracker.addSpeakerChange({ position: 100, speaker: { id: 'u1', name: 'Alice' } });
      tracker.assignSpeakerToSegment(1);

      const stats = tracker.getStats();
      assert.equal(stats.participantCount, 2);
      assert.equal(stats.activeSegments, 1);
      assert.equal(stats.currentSpeaker, 'Alice');
    });
  });
});