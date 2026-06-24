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

  it('corrects every segment still within its grace window on a speaker change', () => {
    const ref = { now: 1000 };
    const t = trackerAt(ref, { gracePeriodMs: 200 });
    t.addSpeakerChange({ position: 0, speaker: { id: 'u1', name: 'Alice' } });
    t.assignSpeakerToSegment(1); // u1 @ t=1000
    ref.now = 1050;
    t.assignSpeakerToSegment(2); // u1 @ t=1050
    ref.now = 1100;
    t.assignSpeakerToSegment(3); // u1 @ t=1100
    // All three were assigned within 200ms of now; a speaker change should fix them all.
    ref.now = 1150;
    t.addSpeakerChange({ position: 150, speaker: { id: 'u2', name: 'Bob' } });
    assert.equal(t.getSpeakerForSegment(1).id, 'u2', 'segment 1 corrected');
    assert.equal(t.getSpeakerForSegment(2).id, 'u2', 'segment 2 corrected');
    assert.equal(t.getSpeakerForSegment(3).id, 'u2', 'segment 3 corrected');
  });

  it('corrects a null (silence) assignment to the new speaker within grace', () => {
    const ref = { now: 1000 };
    const t = trackerAt(ref, { gracePeriodMs: 200 });
    // No speaker yet: assign during silence -> speaker null.
    t.assignSpeakerToSegment(1);
    assert.equal(t.getSpeakerForSegment(1), null, 'assigned during silence');
    ref.now = 1100; // within grace
    t.addSpeakerChange({ position: 100, speaker: { id: 'u1', name: 'Alice' } });
    assert.equal(t.getSpeakerForSegment(1).id, 'u1', 'silence corrected to first speaker');
    // The correction must be recorded (before was null, after non-null).
    const events = t.getRecentEvents();
    const correct = events.find(e => e.action === 'correct' && e.position === 1);
    assert.ok(correct, 'null->non-null correction recorded');
    assert.equal(correct.speaker.id, 'u1');
  });

  it('corrects the same segment more than once while it stays within grace', () => {
    const ref = { now: 1000 };
    const t = trackerAt(ref, { gracePeriodMs: 200 });
    t.addSpeakerChange({ position: 0, speaker: { id: 'u1', name: 'Alice' } });
    t.assignSpeakerToSegment(1); // u1 @ t=1000
    ref.now = 1050; // still within grace
    t.addSpeakerChange({ position: 50, speaker: { id: 'u2', name: 'Bob' } });
    assert.equal(t.getSpeakerForSegment(1).id, 'u2', 'first correction');
    ref.now = 1150; // still within grace of the original assignedAt (1000)
    t.addSpeakerChange({ position: 150, speaker: { id: 'u3', name: 'Carol' } });
    assert.equal(t.getSpeakerForSegment(1).id, 'u3', 'second correction within grace');
  });

  it('_presentSpeaker returns a rejoined participant (in departed Set and participants Map)', () => {
    const t = new SpeakerTracker();
    t.updateParticipant({ action: 'join', participant: { id: 'u1', name: 'Alice' } });
    t.updateParticipant({ action: 'leave', participant: { id: 'u1' } });
    assert.ok(t.departed.has('u1'), 'recorded as departed');
    // Simulate a reordered event where the id is still in departed but the
    // participant is present again in the Map (rejoin).
    t.participants.set('u1', { id: 'u1', name: 'Alice' });
    const speaker = t._presentSpeaker({ id: 'u1', name: 'Alice' });
    assert.ok(speaker, 'rejoined participant is surfaced');
    assert.equal(speaker.id, 'u1');
  });

  it('does not record an event when a speaker change matches the current segment speaker', () => {
    const ref = { now: 1000 };
    const t = trackerAt(ref, { gracePeriodMs: 200 });
    t.addSpeakerChange({ position: 0, speaker: { id: 'u1', name: 'Alice' } });
    t.assignSpeakerToSegment(1); // assign -> u1 (1 event)
    ref.now = 1100; // within grace
    // Same speaker arrives again: entry.speaker is reassigned but no correction event.
    t.addSpeakerChange({ position: 100, speaker: { id: 'u1', name: 'Alice' } });
    const events = t.getRecentEvents();
    assert.equal(events.length, 1, 'no correction event for an identical speaker');
    assert.equal(events[0].action, 'assign');
    assert.equal(t.getSpeakerForSegment(1).id, 'u1');
  });

  it('getSpeakerForSegment returns null for an unknown segmentId', () => {
    const t = new SpeakerTracker();
    assert.equal(t.getSpeakerForSegment(424242), null);
    assert.equal(t.getSpeakerForSegment('nope'), null);
  });

  it('clearSegment on an unknown segmentId is a safe idempotent no-op', () => {
    const t = new SpeakerTracker();
    t.addSpeakerChange({ position: 0, speaker: { id: 'u1', name: 'Alice' } });
    t.assignSpeakerToSegment(1);
    assert.doesNotThrow(() => t.clearSegment(999));
    assert.equal(t.getSpeakerForSegment(1).id, 'u1', 'other segments untouched');
    // Idempotent: clearing the same id twice is fine.
    t.clearSegment(1);
    assert.doesNotThrow(() => t.clearSegment(1));
    assert.equal(t.getSpeakerForSegment(1), null);
  });

  it('constructor uses defaults when options is null/undefined or empty', () => {
    const tNull = new SpeakerTracker(undefined);
    assert.equal(tNull.gracePeriodMs, 200, 'default grace period');
    assert.equal(tNull.eventRingSize, 50, 'default ring size');
    assert.ok(tNull.participants instanceof Map);
    assert.ok(tNull.departed instanceof Set);
    assert.equal(tNull.currentSpeaker, null);
    assert.equal(tNull.lastKnownSpeaker, null);
    assert.deepEqual(tNull.getRecentEvents(), []);
    // Empty options object behaves identically.
    const tEmpty = new SpeakerTracker({});
    assert.equal(tEmpty.gracePeriodMs, 200);
    assert.equal(tEmpty.eventRingSize, 50);
  });

  it('honours explicit zero-valued options (eventRingSize: 0, gracePeriodMs: 0)', () => {
    const ref = { now: 1000 };
    const t = trackerAt(ref, { eventRingSize: 0, gracePeriodMs: 0 });
    assert.equal(t.eventRingSize, 0, '0 is respected, not replaced by default');
    assert.equal(t.gracePeriodMs, 0);
    // With ring size 0 every push is immediately dropped -> ring stays empty.
    t.addSpeakerChange({ position: 0, speaker: { id: 'u1', name: 'Alice' } });
    t.assignSpeakerToSegment(1);
    assert.deepEqual(t.getRecentEvents(), [], 'eventRingSize 0 keeps no events');
    // With grace 0, a later speaker change cannot correct (now - assignedAt = 0, not < 0).
    t.addSpeakerChange({ position: 1, speaker: { id: 'u2', name: 'Bob' } });
    assert.equal(t.getSpeakerForSegment(1).id, 'u1', 'grace 0 -> no correction');
  });

  it('keeps only the most recent event with eventRingSize 1', () => {
    const t = new SpeakerTracker({ eventRingSize: 1 });
    t.addSpeakerChange({ position: 0, speaker: { id: 'u1', name: 'Alice' } });
    t.assignSpeakerToSegment(1);
    t.assignSpeakerToSegment(2);
    const events = t.getRecentEvents();
    assert.equal(events.length, 1, 'ring of size 1 holds a single event');
    assert.equal(events[0].position, 2, 'keeps the most recent');
  });

  it('records events for string and object segmentIds in the position field', () => {
    const t = new SpeakerTracker();
    t.addSpeakerChange({ position: 0, speaker: { id: 'u1', name: 'Alice' } });
    const objId = { ch: 'a', n: 7 };
    t.assignSpeakerToSegment('seg-abc');
    t.assignSpeakerToSegment(objId);
    assert.equal(t.getSpeakerForSegment('seg-abc').id, 'u1', 'string id round-trips');
    assert.equal(t.getSpeakerForSegment(objId).id, 'u1', 'object id round-trips by reference');
    const events = t.getRecentEvents();
    assert.deepEqual(events.map(e => e.position), ['seg-abc', objId], 'position preserves non-numeric ids');
  });
});
