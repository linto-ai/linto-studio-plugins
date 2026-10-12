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

  it('an open segment follows the current speaker; re-assign is a no-op once finalized', () => {
    const ref = { now: 1000 };
    const t = trackerAt(ref, { gracePeriodMs: 200 });
    t.addSpeakerChange({ position: 0, speaker: { id: 'u1', name: 'Alice' } });
    t.assignSpeakerToSegment(5);
    ref.now = 1300; // past grace
    t.addSpeakerChange({ position: 50, speaker: { id: 'u2', name: 'Bob' } });
    t.assignSpeakerToSegment(5); // still partial -> live label follows u2
    assert.equal(t.getSpeakerForSegment(5).id, 'u2', 'partial carries the current speaker');
    ref.now = 1400;
    t.finalizeSegment(5); // u1 300ms vs u2 100ms
    assert.equal(t.getSpeakerForSegment(5).id, 'u1', 'final = majority');
    ref.now = 2000;
    t.addSpeakerChange({ position: 60, speaker: { id: 'u3', name: 'Carol' } });
    t.assignSpeakerToSegment(5); // finalized -> frozen
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

  it('after the grace period a change splits the segment instead of re-attributing it', () => {
    const ref = { now: 1000 };
    const t = trackerAt(ref, { gracePeriodMs: 200 });
    t.addSpeakerChange({ position: 0, speaker: { id: 'u1', name: 'Alice' } });
    t.assignSpeakerToSegment(1);
    ref.now = 1300; // 300ms later, past grace
    t.addSpeakerChange({ position: 300, speaker: { id: 'u2', name: 'Bob' } });
    assert.equal(t.getSpeakerForSegment(1).id, 'u2', 'live label follows the new speaker');
    ref.now = 1400;
    t.finalizeSegment(1);
    assert.equal(t.getSpeakerForSegment(1).id, 'u1', 'u1 kept its 300ms (no grace reset)');
  });

  it('finalizes on the speaker with the most accumulated time (overlap A then B)', () => {
    const ref = { now: 1000 };
    const t = trackerAt(ref, { gracePeriodMs: 200 });
    t.addSpeakerChange({ speaker: { id: 'a', name: 'A' } });
    t.assignSpeakerToSegment(1);
    ref.now = 1500;
    t.addSpeakerChange({ speaker: { id: 'b', name: 'B' } });
    t.assignSpeakerToSegment(1);
    assert.equal(t.getSpeakerForSegment(1).id, 'b');
    ref.now = 3000; // B speaks 1500ms vs A 500ms
    t.finalizeSegment(1);
    assert.equal(t.getSpeakerForSegment(1).id, 'b');
  });

  it('accumulates across alternations and ignores silence in the count', () => {
    const ref = { now: 0 };
    const t = trackerAt(ref, { gracePeriodMs: 200 });
    t.addSpeakerChange({ speaker: { id: 'a' } });
    t.assignSpeakerToSegment(1); // a from 0
    ref.now = 400; t.addSpeakerChange({ speaker: { id: 'b' } }); // a 400
    ref.now = 700; t.addSpeakerChange({ speaker: null }); // b 300, silence
    ref.now = 5000; t.addSpeakerChange({ speaker: { id: 'b' } }); // silence not counted
    ref.now = 5200; t.addSpeakerChange({ speaker: { id: 'a' } }); // b 500 total
    ref.now = 5250;
    t.finalizeSegment(1); // a 450 vs b 500
    assert.equal(t.getSpeakerForSegment(1).id, 'b');
  });

  it('majority ties go to the first speaker of the segment', () => {
    const ref = { now: 0 };
    const t = trackerAt(ref, { gracePeriodMs: 0 });
    t.addSpeakerChange({ speaker: { id: 'a' } });
    t.assignSpeakerToSegment(1);
    ref.now = 300; t.addSpeakerChange({ speaker: { id: 'b' } });
    ref.now = 600;
    t.finalizeSegment(1);
    assert.equal(t.getSpeakerForSegment(1).id, 'a');
  });

  it('finalizing an unseen segment (final with no partial) opens and closes it on the current speaker', () => {
    const t = new SpeakerTracker();
    t.addSpeakerChange({ speaker: { id: 'u1', name: 'Alice' } });
    t.finalizeSegment(4);
    assert.equal(t.getSpeakerForSegment(4).id, 'u1');
    const actions = t.getRecentEvents().map(e => e.action);
    assert.deepEqual(actions, ['assign', 'final']);
  });

  it('majority skips a speaker who has left the meeting', () => {
    const ref = { now: 0 };
    const t = trackerAt(ref, { gracePeriodMs: 0 });
    t.updateParticipant({ action: 'join', participant: { id: 'a' } });
    t.updateParticipant({ action: 'join', participant: { id: 'b' } });
    t.addSpeakerChange({ speaker: { id: 'a' } });
    t.assignSpeakerToSegment(1);
    ref.now = 1000; t.addSpeakerChange({ speaker: { id: 'b' } }); // a 1000
    ref.now = 1200; t.updateParticipant({ action: 'leave', participant: { id: 'a' } });
    ref.now = 1300;
    t.finalizeSegment(1); // a departed -> b (300ms) wins
    assert.equal(t.getSpeakerForSegment(1).id, 'b');
  });

  it('stops crediting a participant once they leave mid-segment', () => {
    const ref = { now: 0 };
    const t = trackerAt(ref, { gracePeriodMs: 0 });
    t.updateParticipant({ action: 'join', participant: { id: 'a' } });
    t.addSpeakerChange({ speaker: { id: 'a' } });
    t.assignSpeakerToSegment(1);
    ref.now = 100;
    t.updateParticipant({ action: 'leave', participant: { id: 'a' } });
    ref.now = 5000;
    assert.equal(t.segmentSpeakers.get(1).durations.get('a').ms, 100);
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
    // With grace 0, a later speaker change is never a grace correction
    // (now - assignedAt = 0, not < 0): it splits the segment, u1 keeps its time.
    t.addSpeakerChange({ position: 1, speaker: { id: 'u2', name: 'Bob' } });
    ref.now = 1100;
    t.addSpeakerChange({ position: 2, speaker: { id: 'u1', name: 'Alice' } });
    ref.now = 1150;
    t.finalizeSegment(1); // u2 100ms vs u1 50ms
    assert.equal(t.getSpeakerForSegment(1).id, 'u2', 'grace 0 -> plain accumulation');
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

// `{ speaker: null, reason: 'unattributed' }`: the dominant audio comes from a
// track the bot has not mapped to a participant yet (SFU newcomer, first
// ~250 ms; a known participant's new track; a departed participant's reused
// track). Once the track is mapped, the bot sends `{ speaker, reason: 'mapped' }`
// naming its participant (after a join if that participant is new). A null
// without reason is plain silence and keeps the lastKnownSpeaker fallback.
//
// The unnamed speaker's time counts in the segment's majority like anyone
// else's, but for the participant its track gets mapped to only: unnamed time
// that wins leaves the segment without speaker. Segments are finalized the way
// the ASR does it (one at a time, the final before the next segment's first
// partial), and a mapping that comes after a final, within the window, still
// names it.
describe('SpeakerTracker unattributed speaker', () => {
  const ALICE = { id: 'u1', name: 'Alice' };
  const BOB = { id: 'u2', name: 'Bob' };
  const CAROL = { id: 'u3', name: 'Carol' };
  const unattributed = (position) => ({ position, speaker: null, reason: 'unattributed' });

  // Alice is a known participant and the current speaker.
  function aliceSpeaking() {
    const ref = { now: 1000 };
    const t = trackerAt(ref, { gracePeriodMs: 200 }); // default 1.5 s unattributed window
    t.updateParticipant({ action: 'join', participant: ALICE });
    t.addSpeakerChange({ position: 0, speaker: ALICE });
    return { ref, t };
  }

  // The bot maps the unattributed track to `participant` (a newcomer joins first).
  function mapped(t, participant, position) {
    if (!t.participants.has(participant.id)) t.updateParticipant({ action: 'join', participant });
    t.addSpeakerChange({ position, speaker: participant, reason: 'mapped' });
  }

  it('never gives a segment starting unattributed to the previous speaker', () => {
    const { ref, t } = aliceSpeaking();
    ref.now = 2000;
    t.addSpeakerChange(unattributed(1000));
    t.assignSpeakerToSegment(5);
    assert.equal(t.getSpeakerForSegment(5), null, 'the partial shows nobody');
    ref.now = 2500;
    t.finalizeSegment(5);
    assert.equal(t.getSpeakerForSegment(5), null, 'nor does the final');
  });

  it('gives the pending segment to the participant its track is mapped to, within the window', () => {
    const { ref, t } = aliceSpeaking();
    ref.now = 2000;
    t.addSpeakerChange(unattributed(1000));
    ref.now = 2100;
    t.assignSpeakerToSegment(5);
    ref.now = 3400; // 1.4 s after the unattributed null, 1.3 s after the assignment (no grace)
    mapped(t, BOB, 2400);
    assert.equal(t.getSpeakerForSegment(5).id, 'u2');
    assert.equal(t.lastKnownSpeaker.id, 'u2');
    t.finalizeSegment(5);
    assert.equal(t.getSpeakerForSegment(5).id, 'u2', 'the unnamed time is now Bob\'s');
  });

  it('is not named by another newcomer who speaks first (Bob unmapped, Carol greets)', () => {
    const { ref, t } = aliceSpeaking();
    ref.now = 10000;
    t.addSpeakerChange(unattributed(9000)); // Bob's track, not mapped yet
    ref.now = 10300;
    t.assignSpeakerToSegment(42); // Bob's words
    ref.now = 10600;
    t.updateParticipant({ action: 'join', participant: CAROL });
    ref.now = 11000;
    t.finalizeSegment(42); // Bob's words end as Carol greets
    t.addSpeakerChange({ position: 10000, speaker: CAROL }); // Carol greets
    assert.equal(t.getSpeakerForSegment(42), null, 'not Carol');
    ref.now = 11200;
    mapped(t, BOB, 10200); // Bob's track mapped at last, within the window
    assert.equal(t.getSpeakerForSegment(42).id, 'u2');
  });

  it('is never named by a participant answering the newcomer: Bob stops, Alice answers', () => {
    const { ref, t } = aliceSpeaking();
    ref.now = 2000;
    t.addSpeakerChange(unattributed(1000)); // Bob, not mapped yet
    t.assignSpeakerToSegment(5);
    ref.now = 2300;
    t.addSpeakerChange({ position: 1300, speaker: null }); // Bob stops
    ref.now = 2600; // within the window
    t.addSpeakerChange({ position: 1600, speaker: ALICE }); // Alice answers
    ref.now = 2700;
    t.finalizeSegment(5); // Bob 300 ms, Alice 100 ms
    assert.equal(t.getSpeakerForSegment(5), null, "Bob's words are not Alice's");
  });

  it('is named by a known participant whose new track was mapped (e.g. screen-share audio)', () => {
    const { ref, t } = aliceSpeaking();
    ref.now = 2000;
    t.addSpeakerChange(unattributed(1000));
    t.assignSpeakerToSegment(5);
    ref.now = 2300;
    mapped(t, ALICE, 1300); // no join: Alice is known
    t.finalizeSegment(5);
    assert.equal(t.getSpeakerForSegment(5).id, 'u1');
  });

  it('is not named by a sender that never says mapped (older bot): unknown', () => {
    const { ref, t } = aliceSpeaking();
    ref.now = 2000;
    t.addSpeakerChange(unattributed(1000));
    t.assignSpeakerToSegment(5);
    ref.now = 2300;
    t.updateParticipant({ action: 'join', participant: BOB });
    t.addSpeakerChange({ position: 1300, speaker: BOB });
    ref.now = 2400;
    t.finalizeSegment(5); // unnamed 300 ms, Bob 100 ms
    assert.equal(t.getSpeakerForSegment(5), null);
  });

  it('leaves the segment without speaker when the track is mapped after the window', () => {
    const { ref, t } = aliceSpeaking();
    ref.now = 2000;
    t.addSpeakerChange(unattributed(1000));
    t.assignSpeakerToSegment(5);
    ref.now = 3600; // 1.6 s after the unattributed null
    mapped(t, BOB, 2600);
    ref.now = 3650;
    t.finalizeSegment(5);
    assert.equal(t.getSpeakerForSegment(5), null);
    ref.now = 3700;
    t.addSpeakerChange({ position: 2700, speaker: ALICE });
    assert.equal(t.getSpeakerForSegment(5), null, 'nor a known participant regaining the floor');
  });

  it('is named by its own episode only: a later unattributed track\'s mapping does not name it', () => {
    const { ref, t } = aliceSpeaking();
    ref.now = 2000;
    t.addSpeakerChange(unattributed(1000)); // Bob's track
    t.assignSpeakerToSegment(5);
    ref.now = 2200;
    t.addSpeakerChange({ position: 1200, speaker: null }); // silence: Bob's track no longer heard
    t.finalizeSegment(5);
    ref.now = 2400;
    t.addSpeakerChange(unattributed(1400)); // Carol's track
    t.assignSpeakerToSegment(6);
    ref.now = 2600;
    mapped(t, CAROL, 1600);
    t.finalizeSegment(6);
    assert.equal(t.getSpeakerForSegment(6).id, 'u3');
    assert.equal(t.getSpeakerForSegment(5), null, "Bob's words are not Carol's");
  });

  it('is not named when another unattributed track takes over without silence (overlap before mapping)', () => {
    const { ref, t } = aliceSpeaking();
    ref.now = 2000;
    t.addSpeakerChange(unattributed(1000)); // Bob's track
    t.assignSpeakerToSegment(5);
    ref.now = 2100;
    t.finalizeSegment(5);
    t.addSpeakerChange(unattributed(1100)); // Carol's track dominates: its own null
    t.assignSpeakerToSegment(6);
    ref.now = 2200;
    t.finalizeSegment(6);
    t.addSpeakerChange(unattributed(1200)); // Bob's again: a new episode
    t.assignSpeakerToSegment(7);
    ref.now = 2300;
    mapped(t, BOB, 1300);
    t.finalizeSegment(7);
    assert.equal(t.getSpeakerForSegment(7).id, 'u2');
    assert.equal(t.getSpeakerForSegment(6), null, "Carol's words are not Bob's");
    assert.equal(t.getSpeakerForSegment(5), null, 'an earlier episode stays unknown');
  });

  it('is named once: a later mapping or a grace-period correction does not rename it', () => {
    const { ref, t } = aliceSpeaking();
    ref.now = 2000;
    t.addSpeakerChange(unattributed(1000));
    t.assignSpeakerToSegment(5);
    ref.now = 2050;
    mapped(t, BOB, 1050);
    ref.now = 2100; // within the window and the segment's grace period
    mapped(t, CAROL, 1100);
    t.addSpeakerChange({ position: 1150, speaker: ALICE });
    ref.now = 2150;
    t.finalizeSegment(5); // Bob 100 ms (named unnamed 50 + his own 50), Alice 50
    assert.equal(t.getSpeakerForSegment(5).id, 'u2');
  });

  it('starts unknown when it begins after the window, and stays unknown', () => {
    const { ref, t } = aliceSpeaking();
    ref.now = 2000;
    t.addSpeakerChange(unattributed(1000));
    ref.now = 3600; // the track is still not mapped
    t.assignSpeakerToSegment(6);
    ref.now = 3650; // within the segment's grace period
    mapped(t, BOB, 2650);
    t.finalizeSegment(6);
    assert.equal(t.getSpeakerForSegment(6), null);
  });

  it('takes back a segment assigned to the previous speaker just before the unattributed null', () => {
    const { ref, t } = aliceSpeaking();
    ref.now = 2000;
    t.assignSpeakerToSegment(5); // the newcomer's first partial beat the bot's event
    assert.equal(t.getSpeakerForSegment(5).id, 'u1');
    ref.now = 2100; // within grace
    t.addSpeakerChange(unattributed(1100));
    assert.equal(t.getSpeakerForSegment(5), null);
    ref.now = 2400; // mapped, past the grace period
    mapped(t, BOB, 1400);
    t.finalizeSegment(5);
    assert.equal(t.getSpeakerForSegment(5).id, 'u2');
  });

  it('leaves older segments alone', () => {
    const { ref, t } = aliceSpeaking();
    ref.now = 2000;
    t.assignSpeakerToSegment(4);
    ref.now = 2300; // past grace
    t.addSpeakerChange(unattributed(1300));
    ref.now = 2400;
    mapped(t, BOB, 1400);
    t.finalizeSegment(4); // Alice 300 ms, then the newcomer (now Bob) 100 ms
    assert.equal(t.getSpeakerForSegment(4).id, 'u1');
  });

  it('keeps the silence behaviour for a null without reason, even right after an unattributed one', () => {
    const { ref, t } = aliceSpeaking();
    ref.now = 2000;
    t.addSpeakerChange({ position: 1000, speaker: null }); // silence
    t.assignSpeakerToSegment(7);
    assert.equal(t.getSpeakerForSegment(7).id, 'u1', 'lastKnownSpeaker fallback');
    t.finalizeSegment(7);
    ref.now = 3000;
    t.addSpeakerChange(unattributed(2000));
    t.assignSpeakerToSegment(8);
    ref.now = 3100;
    t.addSpeakerChange({ position: 2100, speaker: null }); // the unnamed speaker stopped
    t.finalizeSegment(8);
    t.assignSpeakerToSegment(9);
    assert.equal(t.getSpeakerForSegment(9).id, 'u1', 'silence: lastKnownSpeaker fallback again');
    assert.equal(t.getSpeakerForSegment(8), null, 'the unattributed segment stays unnamed');
  });

  it('records the unattributed, pending and resolve events', () => {
    const { ref, t } = aliceSpeaking();
    ref.now = 2000;
    t.addSpeakerChange(unattributed(1000));
    t.assignSpeakerToSegment(5);
    mapped(t, BOB, 1100);
    assert.deepEqual(t.getRecentEvents().map((e) => [e.position, e.action, e.speaker && e.speaker.id]), [
      [1000, 'unattributed', null], [5, 'pending', null], [5, 'resolve', 'u2'],
    ]);
  });

  it('clear() forgets the unattributed state', () => {
    const { ref, t } = aliceSpeaking();
    ref.now = 2000;
    t.addSpeakerChange(unattributed(1000));
    t.clear();
    assert.equal(t.unattributedSince, null);
    assert.equal(t.unattributedEpisode, 0);
    t.addSpeakerChange({ position: 0, speaker: ALICE });
    t.addSpeakerChange({ position: 50, speaker: null });
    t.assignSpeakerToSegment(1);
    assert.equal(t.getSpeakerForSegment(1).id, 'u1');
  });

  // Next's majority: the newcomer's time is counted, under its own (unnamed)
  // name, against everyone else's in the segment.
  it('counts the unnamed speaker in the majority, named once its track is mapped', () => {
    const { ref, t } = aliceSpeaking();
    ref.now = 2000;
    t.assignSpeakerToSegment(5); // Alice speaks 400 ms
    ref.now = 2400;
    t.addSpeakerChange(unattributed(1400)); // then the newcomer, 800 ms
    t.assignSpeakerToSegment(5); // the next partial
    assert.equal(t.getSpeakerForSegment(5), null, 'the partial shows nobody while the newcomer speaks');
    ref.now = 2700;
    mapped(t, BOB, 1700);
    t.assignSpeakerToSegment(5);
    assert.equal(t.getSpeakerForSegment(5).id, 'u2', 'then the mapped participant');
    ref.now = 3200;
    t.finalizeSegment(5);
    assert.equal(t.getSpeakerForSegment(5).id, 'u2', 'Bob 800 ms vs Alice 400 ms');
  });

  it('a newcomer never mapped and speaking the most leaves the segment unknown, not the previous speaker', () => {
    const { ref, t } = aliceSpeaking();
    ref.now = 2000;
    t.assignSpeakerToSegment(5);
    ref.now = 2400;
    t.addSpeakerChange(unattributed(1400));
    ref.now = 3200;
    t.finalizeSegment(5); // unnamed 800 ms vs Alice 400 ms
    assert.equal(t.getSpeakerForSegment(5), null);
  });
});

// With a `track` tag on its unattributed and mapped changes, the bot names the
// unmapped track speaking every time it becomes the speaker (again, after
// another track or a silence): `{ speaker: null, reason: 'unattributed', track }`,
// then `{ speaker, reason: 'mapped', track }` once that track is mapped. The
// time track T is the speaker is T's: only T's mapping names it, within the
// window opened by T's first null.
describe('SpeakerTracker unattributed speaker, per track', () => {
  const ALICE = { id: 'u1', name: 'Alice' };
  const BOB = { id: 'u2', name: 'Bob' };
  const CAROL = { id: 'u3', name: 'Carol' };
  const unattributed = (position, track) => ({ position, speaker: null, reason: 'unattributed', track });
  const mapped = (position, speaker, track) => ({ position, speaker, reason: 'mapped', track });

  function aliceSpeaking() {
    const ref = { now: 1000 };
    const t = trackerAt(ref, { gracePeriodMs: 200 }); // default 1.5 s unattributed window
    t.updateParticipant({ action: 'join', participant: ALICE });
    t.addSpeakerChange({ position: 0, speaker: ALICE });
    return { ref, t };
  }
  const speakerOf = (t, segmentId) => (t.getSpeakerForSegment(segmentId) || { id: null }).id;
  // The ASR's next segment: the previous one's final, then the new one's first partial.
  function next(t, previous, segmentId) {
    if (previous != null) t.finalizeSegment(previous);
    t.assignSpeakerToSegment(segmentId);
  }

  it('names each track\'s turns with its own mapping when two unmapped tracks alternate', () => {
    const { ref, t } = aliceSpeaking();
    ref.now = 2000; t.addSpeakerChange(unattributed(1000, 'tb')); next(t, null, 5); // Bob's track
    ref.now = 2300; t.finalizeSegment(5); t.addSpeakerChange(unattributed(1300, 'tc')); t.assignSpeakerToSegment(6); // Carol's
    ref.now = 2600; t.finalizeSegment(6); t.addSpeakerChange(unattributed(1600, 'tb')); t.assignSpeakerToSegment(7); // Bob again
    ref.now = 2900; t.finalizeSegment(7); t.addSpeakerChange(unattributed(1900, 'tc')); t.assignSpeakerToSegment(8); // Carol again
    ref.now = 3000; t.addSpeakerChange(mapped(2000, BOB, 'tb'));
    assert.deepEqual([5, 6, 7, 8].map((s) => speakerOf(t, s)), ['u2', null, 'u2', null]);
    ref.now = 3100; t.addSpeakerChange(mapped(2100, CAROL, 'tc'));
    t.assignSpeakerToSegment(8);
    assert.deepEqual([5, 6, 7, 8].map((s) => speakerOf(t, s)), ['u2', 'u3', 'u2', 'u3']);
    next(t, 8, 9);
    assert.equal(speakerOf(t, 8), 'u3');
    assert.equal(speakerOf(t, 9), 'u3', 'Carol, mapped while speaking, is the speaker');
  });

  it('a track mapped while another one speaks names its own segments only, the speaker is unchanged', () => {
    const { ref, t } = aliceSpeaking();
    ref.now = 2000; t.addSpeakerChange(unattributed(1000, 'tb')); next(t, null, 5);
    ref.now = 2300; t.finalizeSegment(5); t.addSpeakerChange(unattributed(1300, 'tc')); t.assignSpeakerToSegment(6);
    ref.now = 2400; t.addSpeakerChange(mapped(1400, BOB, 'tb'));
    assert.equal(speakerOf(t, 5), 'u2');
    assert.equal(speakerOf(t, 6), null);
    assert.equal(t.currentSpeaker, null, 'still the unmapped Carol speaking, not Bob');
    next(t, 6, 7);
    assert.equal(speakerOf(t, 7), null, 'Carol\'s, pending');
    ref.now = 2500; t.addSpeakerChange(mapped(1500, CAROL, 'tc'));
    t.finalizeSegment(7);
    assert.deepEqual([6, 7].map((s) => speakerOf(t, s)), ['u3', 'u3']);
  });

  it('a track mapped after a named speaker took over still names its segments, the named speaker stays current', () => {
    const { ref, t } = aliceSpeaking();
    ref.now = 2000; t.addSpeakerChange(unattributed(1000, 'tb')); next(t, null, 5);
    ref.now = 2300; t.finalizeSegment(5); t.addSpeakerChange({ position: 1300, speaker: ALICE }); // Alice answers
    assert.equal(speakerOf(t, 5), null, 'not Alice');
    ref.now = 2600; t.addSpeakerChange(mapped(1600, BOB, 'tb'));
    assert.equal(speakerOf(t, 5), 'u2');
    t.assignSpeakerToSegment(6);
    assert.equal(speakerOf(t, 6), 'u1', 'Alice is still the speaker');
  });

  it('keeps the window of the first null when a track resumes after a short silence', () => {
    const { ref, t } = aliceSpeaking();
    ref.now = 2000; t.addSpeakerChange(unattributed(1000, 'tb')); next(t, null, 5);
    ref.now = 2300; t.addSpeakerChange({ position: 1300, speaker: null }); // silence
    next(t, 5, 6);
    ref.now = 2800; t.finalizeSegment(6); t.addSpeakerChange(unattributed(1800, 'tb')); // Bob resumes
    ref.now = 3050; t.assignSpeakerToSegment(7);
    ref.now = 3300; t.addSpeakerChange(mapped(2300, BOB, 'tb')); // within 2000 + 1.5 s
    t.finalizeSegment(7);
    assert.deepEqual([5, 6, 7].map((s) => speakerOf(t, s)), ['u2', 'u1', 'u2'],
      'both of Bob\'s turns named; the silence keeps the lastKnownSpeaker fallback');
  });

  it('opens no new window when a track resumes after its window: the late turn stays unknown', () => {
    const { ref, t } = aliceSpeaking();
    ref.now = 2000; t.addSpeakerChange(unattributed(1000, 'tb')); next(t, null, 5);
    ref.now = 2300; t.addSpeakerChange({ position: 1300, speaker: null }); t.finalizeSegment(5);
    ref.now = 4500; t.addSpeakerChange(unattributed(3500, 'tb')); // after 2 s of silence
    t.assignSpeakerToSegment(7);
    ref.now = 4600; t.addSpeakerChange(mapped(3600, BOB, 'tb'));
    t.finalizeSegment(7);
    assert.deepEqual([5, 7].map((s) => speakerOf(t, s)), [null, null]);
  });

  it('gives a segment assigned just before another track\'s null to that track', () => {
    const { ref, t } = aliceSpeaking();
    ref.now = 2000; t.addSpeakerChange(unattributed(1000, 'tb'));
    ref.now = 2300; t.assignSpeakerToSegment(6);
    ref.now = 2350; t.addSpeakerChange(unattributed(1350, 'tc')); // within the grace period
    ref.now = 2400; t.addSpeakerChange(mapped(1400, BOB, 'tb'));
    t.assignSpeakerToSegment(6);
    assert.equal(speakerOf(t, 6), null, 'not Bob\'s');
    ref.now = 2500; t.addSpeakerChange(mapped(1500, CAROL, 'tc'));
    t.finalizeSegment(6);
    assert.equal(speakerOf(t, 6), 'u3');
  });

  it('without a track tag keeps the latest-null rule; a tagged mapping never names an untagged segment', () => {
    const { ref, t } = aliceSpeaking();
    ref.now = 2000; t.addSpeakerChange(unattributed(1000, '')); next(t, null, 5); // empty tag: untagged
    ref.now = 2100; t.addSpeakerChange(mapped(1100, BOB));
    t.finalizeSegment(5);
    assert.equal(speakerOf(t, 5), 'u2');
    ref.now = 3000; t.addSpeakerChange(unattributed(2000)); t.assignSpeakerToSegment(6);
    ref.now = 3100; t.addSpeakerChange(mapped(2100, CAROL, 'tc'));
    t.finalizeSegment(6);
    assert.equal(speakerOf(t, 6), null);
  });

  it('remembers a bounded number of track tags; clear() forgets them', () => {
    const { ref, t } = aliceSpeaking();
    for (let i = 0; i < 300; i++) t.addSpeakerChange(unattributed(i, `t${i}`));
    assert.equal(t.trackSince.size, 256);
    t.clear();
    assert.equal(t.trackSince.size, 0);
    assert.equal(t.currentTrack, null);
    ref.now = 9000; t.addSpeakerChange(unattributed(0, 't299')); t.assignSpeakerToSegment(1);
    ref.now = 9100; t.addSpeakerChange(mapped(100, BOB, 't299'));
    t.finalizeSegment(1);
    assert.equal(speakerOf(t, 1), 'u2', 'a fresh window after clear()');
  });

  it('clear() forgets the current track', () => {
    const { ref, t } = aliceSpeaking();
    ref.now = 2000; t.addSpeakerChange(unattributed(1000, 'tb'));
    t.clear();
    assert.equal(t.currentTrack, null);
    t.addSpeakerChange({ position: 0, speaker: ALICE });
    t.addSpeakerChange({ position: 50, speaker: null });
    t.assignSpeakerToSegment(1);
    assert.equal(speakerOf(t, 1), 'u1');
  });

  it('counts two unmapped tracks of one segment apart, each named by its own mapping', () => {
    const { ref, t } = aliceSpeaking();
    ref.now = 2000; t.addSpeakerChange(unattributed(1000, 'tb')); t.assignSpeakerToSegment(5);
    ref.now = 2300; t.addSpeakerChange(unattributed(1300, 'tc'));
    ref.now = 2700; t.addSpeakerChange(mapped(1700, CAROL, 'tc'));
    ref.now = 2800; t.addSpeakerChange(mapped(1800, BOB, 'tb')); // Bob mapped while Carol speaks
    ref.now = 2900;
    t.finalizeSegment(5); // Bob 300 ms, Carol 400 + 200 ms
    assert.equal(speakerOf(t, 5), 'u3');
  });
});
