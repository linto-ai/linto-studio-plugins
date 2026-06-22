const assert = require('assert');
const { describe, it } = require('mocha');
const SpeakerTracker = require('../components/StreamingServer/SpeakerTracker');

// Deterministic clock so grace-period behaviour is testable.
function trackerAt(timeRef, options) {
  const t = new SpeakerTracker(options);
  t._now = () => timeRef.now;
  return t;
}

describe('SpeakerTracker (native diarization)', () => {
  it('tracks participant join/leave', () => {
    const t = new SpeakerTracker();
    t.updateParticipant({ action: 'join', participant: { id: 'u1', name: 'Alice' } });
    assert.equal(t.participants.size, 1);
    t.updateParticipant({ action: 'leave', participant: { id: 'u1' } });
    assert.equal(t.participants.size, 0);
  });

  it('updates currentSpeaker and keeps lastKnownSpeaker through silence', () => {
    const t = new SpeakerTracker();
    t.addSpeakerChange({ position: 0, speaker: { id: 'u1', name: 'Alice' } });
    assert.equal(t.currentSpeaker.id, 'u1');
    assert.equal(t.lastKnownSpeaker.id, 'u1');
    t.addSpeakerChange({ position: 100, speaker: null }); // silence
    assert.equal(t.currentSpeaker, null);
    assert.equal(t.lastKnownSpeaker.id, 'u1', 'lastKnownSpeaker survives silence');
  });

  it('assigns the current speaker to a segment; re-assign is a no-op once locked', () => {
    const ref = { now: 1000 };
    const t = trackerAt(ref, { gracePeriodMs: 200 });
    t.addSpeakerChange({ position: 0, speaker: { id: 'u1', name: 'Alice' } });
    t.assignSpeakerToSegment(5);
    ref.now = 1300; // past grace -> the assignment is locked
    t.addSpeakerChange({ position: 50, speaker: { id: 'u2', name: 'Bob' } });
    t.assignSpeakerToSegment(5); // already assigned -> no-op
    assert.equal(t.getSpeakerForSegment(5).id, 'u1');
  });

  it('falls back to lastKnownSpeaker during silence', () => {
    const t = new SpeakerTracker();
    t.addSpeakerChange({ position: 0, speaker: { id: 'u1', name: 'Alice' } });
    t.addSpeakerChange({ position: 50, speaker: null });
    t.assignSpeakerToSegment(7);
    assert.equal(t.getSpeakerForSegment(7).id, 'u1');
  });

  it('reactively corrects a segment within the grace period', () => {
    const ref = { now: 1000 };
    const t = trackerAt(ref, { gracePeriodMs: 200 });
    t.addSpeakerChange({ position: 0, speaker: { id: 'u1', name: 'Alice' } });
    t.assignSpeakerToSegment(1); // assigned to u1 at t=1000
    ref.now = 1100; // 100ms later, within grace
    t.addSpeakerChange({ position: 100, speaker: { id: 'u2', name: 'Bob' } });
    assert.equal(t.getSpeakerForSegment(1).id, 'u2', 'corrected within grace');
  });

  it('does not correct a segment after the grace period', () => {
    const ref = { now: 1000 };
    const t = trackerAt(ref, { gracePeriodMs: 200 });
    t.addSpeakerChange({ position: 0, speaker: { id: 'u1', name: 'Alice' } });
    t.assignSpeakerToSegment(1);
    ref.now = 1300; // 300ms later, past grace
    t.addSpeakerChange({ position: 300, speaker: { id: 'u2', name: 'Bob' } });
    assert.equal(t.getSpeakerForSegment(1).id, 'u1', 'locked after grace');
  });

  it('clears a segment and all state', () => {
    const t = new SpeakerTracker();
    t.addSpeakerChange({ position: 0, speaker: { id: 'u1', name: 'Alice' } });
    t.assignSpeakerToSegment(1);
    t.clearSegment(1);
    assert.equal(t.getSpeakerForSegment(1), null);
    t.updateParticipant({ action: 'join', participant: { id: 'u1', name: 'Alice' } });
    t.clear();
    assert.equal(t.participants.size, 0);
    assert.equal(t.currentSpeaker, null);
    assert.equal(t.lastKnownSpeaker, null);
  });
});
