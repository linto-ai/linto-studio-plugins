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

  it('clears the current/last speaker when that participant leaves', () => {
    const t = new SpeakerTracker();
    t.updateParticipant({ action: 'join', participant: { id: 'u1', name: 'Alice' } });
    t.addSpeakerChange({ position: 0, speaker: { id: 'u1', name: 'Alice' } });
    t.updateParticipant({ action: 'leave', participant: { id: 'u1' } });
    assert.equal(t.currentSpeaker, null, 'departed participant no longer current');
    assert.equal(t.lastKnownSpeaker, null, 'departed participant not used as fallback');
  });

  it('does not stamp a segment with a participant who left before the read', () => {
    const ref = { now: 1000 };
    const t = trackerAt(ref, { gracePeriodMs: 200 });
    t.updateParticipant({ action: 'join', participant: { id: 'u1', name: 'Alice' } });
    t.addSpeakerChange({ position: 0, speaker: { id: 'u1', name: 'Alice' } });
    t.assignSpeakerToSegment(9); // assigned to u1 while present
    // Reordered events: participant-left arrives after the segment was assigned
    // but before its speaker is read.
    ref.now = 1300; // past grace, so the assignment is otherwise locked
    t.updateParticipant({ action: 'leave', participant: { id: 'u1' } });
    assert.equal(t.getSpeakerForSegment(9), null, 'departed participant is not surfaced for the segment');
  });

  it('assigns null when the current/last speaker has already left at assign time', () => {
    const t = new SpeakerTracker();
    t.updateParticipant({ action: 'join', participant: { id: 'u1', name: 'Alice' } });
    t.addSpeakerChange({ position: 0, speaker: { id: 'u1', name: 'Alice' } });
    t.updateParticipant({ action: 'leave', participant: { id: 'u1' } });
    t.assignSpeakerToSegment(11); // u1 already departed -> must not be stamped
    assert.equal(t.getSpeakerForSegment(11), null, 'departed participant not assigned');
  });

  it('records assignment and grace-correction events in the bounded ring', () => {
    const ref = { now: 1000 };
    const t = trackerAt(ref, { gracePeriodMs: 200 });
    t.addSpeakerChange({ position: 0, speaker: { id: 'u1', name: 'Alice' } });
    t.assignSpeakerToSegment(1); // assign u1
    ref.now = 1100; // within grace
    t.addSpeakerChange({ position: 100, speaker: { id: 'u2', name: 'Bob' } }); // correct -> u2
    const events = t.getRecentEvents();
    assert.equal(events.length, 2);
    assert.deepEqual({ position: events[0].position, action: events[0].action, speaker: events[0].speaker.id },
      { position: 1, action: 'assign', speaker: 'u1' });
    assert.deepEqual({ position: events[1].position, action: events[1].action, speaker: events[1].speaker.id },
      { position: 1, action: 'correct', speaker: 'u2' });
  });

  it('caps the event ring at eventRingSize (FIFO)', () => {
    const t = new SpeakerTracker({ eventRingSize: 3 });
    t.addSpeakerChange({ position: 0, speaker: { id: 'u1', name: 'Alice' } });
    for (let i = 0; i < 10; i++) t.assignSpeakerToSegment(i);
    const events = t.getRecentEvents();
    assert.equal(events.length, 3, 'ring is bounded');
    assert.deepEqual(events.map(e => e.position), [7, 8, 9], 'keeps the most recent');
  });

  it('getRecentEvents returns a copy that cannot mutate internal state', () => {
    const t = new SpeakerTracker();
    t.addSpeakerChange({ position: 0, speaker: { id: 'u1', name: 'Alice' } });
    t.assignSpeakerToSegment(1);
    const snap = t.getRecentEvents();
    snap.push({ position: 99 });
    assert.equal(t.getRecentEvents().length, 1, 'caller mutation does not leak');
  });

  it('clears the event ring on clear()', () => {
    const t = new SpeakerTracker();
    t.addSpeakerChange({ position: 0, speaker: { id: 'u1', name: 'Alice' } });
    t.assignSpeakerToSegment(1);
    assert.equal(t.getRecentEvents().length, 1);
    t.clear();
    assert.equal(t.getRecentEvents().length, 0);
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
