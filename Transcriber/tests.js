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

    it('should track lastKnownSpeaker', () => {
      const tracker = new SpeakerTracker();
      tracker.addSpeakerChange({ position: 100, speaker: { id: 'u1', name: 'Alice' } });
      assert.deepEqual(tracker.lastKnownSpeaker, { id: 'u1', name: 'Alice' });
    });

    it('should not reset lastKnownSpeaker on silence', () => {
      const tracker = new SpeakerTracker();
      tracker.addSpeakerChange({ position: 100, speaker: { id: 'u1', name: 'Alice' } });
      tracker.addSpeakerChange({ position: 200, speaker: null });
      assert.equal(tracker.currentSpeaker, null);
      assert.deepEqual(tracker.lastKnownSpeaker, { id: 'u1', name: 'Alice' });
    });

    it('should not update segments with null speaker (silence)', () => {
      const tracker = new SpeakerTracker();
      tracker.addSpeakerChange({ position: 100, speaker: { id: 'u1', name: 'Alice' } });
      tracker.assignSpeakerToSegment(1);

      // Silence event should not overwrite the segment
      tracker.addSpeakerChange({ position: 200, speaker: null });
      assert.deepEqual(tracker.getSpeakerForSegment(1), { id: 'u1', name: 'Alice' });
    });
  });

  describe('#assignSpeakerToSegment()', () => {
    it('should assign speaker at first call for a segmentId', () => {
      const tracker = new SpeakerTracker();
      tracker.addSpeakerChange({ position: 100, speaker: { id: 'u1', name: 'Alice' } });
      tracker.assignSpeakerToSegment(1);
      assert.deepEqual(tracker.getSpeakerForSegment(1), { id: 'u1', name: 'Alice' });
    });

    it('should use lastKnownSpeaker when currentSpeaker is null', () => {
      const tracker = new SpeakerTracker();
      tracker.addSpeakerChange({ position: 100, speaker: { id: 'u1', name: 'Alice' } });
      tracker.addSpeakerChange({ position: 200, speaker: null }); // silence
      tracker.assignSpeakerToSegment(1);
      // Should fall back to Alice (lastKnownSpeaker)
      assert.deepEqual(tracker.getSpeakerForSegment(1), { id: 'u1', name: 'Alice' });
    });

    it('should not create new entry on subsequent calls for same segmentId (no grace period)', () => {
      const tracker = new SpeakerTracker({ gracePeriodMs: 0 });
      tracker.addSpeakerChange({ position: 100, speaker: { id: 'u1', name: 'Alice' } });
      tracker.assignSpeakerToSegment(1);

      // Speaker changes, but without grace period, segment stays frozen
      tracker.addSpeakerChange({ position: 200, speaker: { id: 'u2', name: 'Bob' } });
      tracker.assignSpeakerToSegment(1);
      assert.deepEqual(tracker.getSpeakerForSegment(1), { id: 'u1', name: 'Alice' });
    });

    it('should assign different speakers to different segments', () => {
      const tracker = new SpeakerTracker();
      tracker.addSpeakerChange({ position: 100, speaker: { id: 'u1', name: 'Alice' } });
      tracker.assignSpeakerToSegment(1);

      // Segment 1 finishes (simulates final + clearSegment)
      tracker.clearSegment(1);

      tracker.addSpeakerChange({ position: 500, speaker: { id: 'u2', name: 'Bob' } });
      tracker.assignSpeakerToSegment(2);

      assert.deepEqual(tracker.getSpeakerForSegment(2), { id: 'u2', name: 'Bob' });
    });
  });

  describe('grace period', () => {
    it('should allow reactive correction within grace period', () => {
      const tracker = new SpeakerTracker(); // default 200ms grace
      // First partial arrives, assigned to Alice
      tracker.addSpeakerChange({ position: 100, speaker: { id: 'u1', name: 'Alice' } });
      tracker.assignSpeakerToSegment(1);
      assert.deepEqual(tracker.getSpeakerForSegment(1), { id: 'u1', name: 'Alice' });

      // speakerChanged(Bob) arrives shortly after (within grace period)
      // This corrects segment 1: Bob was actually speaking
      tracker.addSpeakerChange({ position: 150, speaker: { id: 'u2', name: 'Bob' } });
      assert.deepEqual(tracker.getSpeakerForSegment(1), { id: 'u2', name: 'Bob' });
    });

    it('should lock speaker after grace period expires', (done) => {
      const tracker = new SpeakerTracker({ gracePeriodMs: 50 });
      tracker.addSpeakerChange({ position: 100, speaker: { id: 'u1', name: 'Alice' } });
      tracker.assignSpeakerToSegment(1);

      setTimeout(() => {
        // Grace period expired, speakerChanged should NOT update segment 1
        tracker.addSpeakerChange({ position: 500, speaker: { id: 'u2', name: 'Bob' } });
        assert.deepEqual(tracker.getSpeakerForSegment(1), { id: 'u1', name: 'Alice' });
        done();
      }, 100);
    });

    it('should not reactively update with grace period of 0', () => {
      const tracker = new SpeakerTracker({ gracePeriodMs: 0 });
      tracker.addSpeakerChange({ position: 100, speaker: { id: 'u1', name: 'Alice' } });
      tracker.assignSpeakerToSegment(1);

      // speakerChanged(Bob) arrives, but grace period is 0 so no reactive update
      tracker.addSpeakerChange({ position: 150, speaker: { id: 'u2', name: 'Bob' } });
      assert.deepEqual(tracker.getSpeakerForSegment(1), { id: 'u1', name: 'Alice' });
    });

    it('should not update cleared segments', () => {
      const tracker = new SpeakerTracker(); // default 200ms grace
      tracker.addSpeakerChange({ position: 100, speaker: { id: 'u1', name: 'Alice' } });
      tracker.assignSpeakerToSegment(1);

      // Segment 1 finishes (final emitted, segment cleared)
      tracker.clearSegment(1);

      // speakerChanged arrives, but segment 1 is already gone
      tracker.addSpeakerChange({ position: 200, speaker: { id: 'u2', name: 'Bob' } });
      assert.equal(tracker.getSpeakerForSegment(1), null);
    });

    it('should only update segments within grace period, not old ones', (done) => {
      const tracker = new SpeakerTracker({ gracePeriodMs: 50 });
      tracker.addSpeakerChange({ position: 100, speaker: { id: 'u1', name: 'Alice' } });
      tracker.assignSpeakerToSegment(1);

      setTimeout(() => {
        // Segment 1 grace expired. Create segment 2 (within grace)
        tracker.assignSpeakerToSegment(2);

        // speakerChanged should update segment 2 but NOT segment 1
        tracker.addSpeakerChange({ position: 500, speaker: { id: 'u2', name: 'Bob' } });
        assert.deepEqual(tracker.getSpeakerForSegment(1), { id: 'u1', name: 'Alice' });
        assert.deepEqual(tracker.getSpeakerForSegment(2), { id: 'u2', name: 'Bob' });
        done();
      }, 100);
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
      assert.equal(tracker.lastKnownSpeaker, null);
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
