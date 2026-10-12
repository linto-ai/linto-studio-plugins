const assert = require('assert');
const { describe, it } = require('mocha');
const SpeakerTracker = require('../components/StreamingServer/SpeakerTracker');

// init.speakerEvents: when the bot's speaker events lead the speech ('leading',
// SFU: the mixer's VAD on the audio itself), they precede the ASR's first
// partial of the same speech by the ASR latency. Correcting a segment backward
// toward a change that arrives just after its first partial then names the
// next speaker's words. 'lagging' (Teams' polled indicator) and an absent
// field keep the grace period, which those events need.

// The SpeakerTracker input of the end-to-end chain (page script -> Bot ->
// AudioMixer -> TranscriberStream frames, BotService 7e4fb40, 20 ms steps) for
// the review's scenarios: 2c (a newcomer talks over another one right after
// its first partial), 3 (two unmapped tracks alternating every 100 ms), 3b/3c
// (an interjection, mapped while one or the other is dominant), 4a/4b (a track
// resuming after a 1 s / 2.5 s pause, mapped late). Each op is [time, kind,
// argument]; 'read' is when the segment's final reads its speaker.
const SFU_SEQUENCES = require('./fixtures/sfu-speaker-sequences.json');

function replay(sequence, speakerEvents) {
  let now = 0;
  const t = new SpeakerTracker({ speakerEvents });
  t._now = () => now;
  const got = {};
  for (const [time, kind, arg] of sequence.ops) {
    now = 100000 + time;
    if (kind === 'change') t.addSpeakerChange(arg);
    else if (kind === 'participant') t.updateParticipant(arg);
    else if (kind === 'assign') t.assignSpeakerToSegment(arg);
    else if (kind === 'read') {
      // The segment's final, as the ASR reads it: majority over the segment.
      t.finalizeSegment(arg);
      const speaker = t.getSpeakerForSegment(arg);
      got[arg] = speaker ? speaker.id : null;
    }
  }
  return Object.entries(sequence.truth).map(([segment, truth]) => {
    const name = got[segment];
    return { segment, truth, name, verdict: name === truth ? 'ok' : (name === null ? 'unknown' : 'WRONG') };
  });
}
const wrong = (results) => results.filter((r) => r.verdict === 'WRONG');

// In these recordings a segment's first partial comes about this long after
// the speaker change that starts its speech (the ASR latency).
const RECORDED_ASR_LATENCY_MS = 380;

// Teams-like timing for the same speech: named events only, each arriving
// `lagMs` after the first partial the speech change would get, i.e. after its
// change in the recording plus the ASR latency. Every change of the recorded
// speech is kept, a speaker resuming in a segment still open included: without
// a backward correction, a segment's final is the speaker with the most time
// in it. An unattributed track counts as the participant it gets mapped to.
function laggingSequence(sequence, lagMs) {
  const ops = [];
  const people = new Set(Object.values(sequence.truth));
  for (const id of people) ops.push([0, 'participant', { action: 'join', participant: { id, name: id } }]);
  const owners = {};
  for (const [, kind, arg] of sequence.ops) {
    if (kind === 'change' && arg.reason === 'mapped') owners[arg.track] = arg.speaker.id;
  }
  let previous = null;
  for (const [time, kind, arg] of sequence.ops) {
    if (kind === 'assign' || kind === 'read') {
      ops.push([time, kind, arg]);
      continue;
    }
    if (kind !== 'change') continue;
    const speaker = arg.reason === 'unattributed' ? owners[arg.track] : (arg.speaker && arg.speaker.id);
    if (!speaker || speaker === previous) continue; // silence, or the same speaker
    ops.push([time + RECORDED_ASR_LATENCY_MS + lagMs, 'change', { speaker: { id: speaker, name: speaker } }]);
    previous = speaker;
  }
  ops.sort((a, b) => a[0] - b[0]);
  return { truth: sequence.truth, ops };
}

describe('SpeakerTracker and the timing of the speaker events (init.speakerEvents)', () => {
  for (const [name, sequence] of Object.entries(SFU_SEQUENCES)) {
    it(`SFU scenario ${name} with leading events: no wrong name`, () => {
      const results = replay(sequence, 'leading');
      assert.deepStrictEqual(wrong(results), [], JSON.stringify(results));
    });
  }

  it('the same SFU scenarios name wrong speakers with the grace period (why leading events disable it)', () => {
    const results = Object.values(SFU_SEQUENCES).flatMap((sequence) => replay(sequence, undefined));
    assert.ok(wrong(results).length > 0, JSON.stringify(results));
  });

  // Scenario 3 is left out: speakers alternating every 100 ms cannot come from
  // Teams' indicator, polled every 200 ms.
  const TEAMS_LIKE = Object.entries(SFU_SEQUENCES).filter(([name]) => name !== '3');
  for (const lagMs of [60, 150]) {
    for (const [name, sequence] of TEAMS_LIKE) {
      it(`Teams-like timing (events ${lagMs} ms after the first partial), scenario ${name}: the grace period still names them right`, () => {
        const lagging = laggingSequence(sequence, lagMs);
        for (const speakerEvents of ['lagging', undefined, 'unknown-value']) {
          const results = replay(lagging, speakerEvents);
          assert.ok(results.every((r) => r.verdict === 'ok'), `${speakerEvents}: ${JSON.stringify(results)}`);
        }
      });
    }
  }

  it('Teams-like timing with the grace period disabled would name the previous speaker', () => {
    const results = TEAMS_LIKE.flatMap(([, sequence]) => replay(laggingSequence(sequence, 150), 'leading'));
    assert.ok(wrong(results).length > 0, JSON.stringify(results));
  });

  describe('with leading events', () => {
    const ALICE = { id: 'u1', name: 'Alice' };
    const BOB = { id: 'u2', name: 'Bob' };
    function leading() {
      const ref = { now: 1000 };
      const t = new SpeakerTracker({ speakerEvents: 'leading' });
      t._now = () => ref.now;
      t.updateParticipant({ action: 'join', participant: ALICE });
      t.addSpeakerChange({ position: 0, speaker: ALICE });
      return { ref, t };
    }

    it('does not correct a segment toward a named change arriving just after its first partial', () => {
      const { ref, t } = leading();
      ref.now = 2000; t.assignSpeakerToSegment(5); // Alice's last words
      ref.now = 2100; t.addSpeakerChange({ position: 1100, speaker: BOB }); // Bob's next words
      assert.strictEqual(t.getSpeakerForSegment(5).id, 'u1');
    });

    it('does not take a segment back for an unmapped track arriving just after its first partial', () => {
      const { ref, t } = leading();
      ref.now = 2000; t.assignSpeakerToSegment(5);
      ref.now = 2100; t.addSpeakerChange({ position: 1100, speaker: null, reason: 'unattributed', track: 'tb' });
      ref.now = 2200; t.addSpeakerChange({ position: 1200, speaker: BOB, reason: 'mapped', track: 'tb' });
      assert.strictEqual(t.getSpeakerForSegment(5).id, 'u1');
    });

    it('leaves unnamed a segment starting right after an unmapped track took over: it may hold the previous speaker\'s words', () => {
      const { ref, t } = leading();
      ref.now = 2000; t.addSpeakerChange({ position: 1000, speaker: null, reason: 'unattributed', track: 'tb' });
      ref.now = 2150; t.assignSpeakerToSegment(5); // 150 ms after the takeover
      ref.now = 2500; t.assignSpeakerToSegment(6); // 500 ms after: Bob's
      ref.now = 2600; t.addSpeakerChange({ position: 1600, speaker: BOB, reason: 'mapped', track: 'tb' });
      assert.strictEqual(t.getSpeakerForSegment(5), null);
      assert.strictEqual(t.getSpeakerForSegment(6).id, 'u2');
    });

    it('names a segment starting right after the same track resumed (no takeover)', () => {
      const { ref, t } = leading();
      ref.now = 2000; t.addSpeakerChange({ position: 1000, speaker: null, reason: 'unattributed', track: 'tb' });
      ref.now = 4500; t.addSpeakerChange({ position: 3500, speaker: null, reason: 'unattributed', track: 'tb' }); // after a long silence
      ref.now = 4600; t.assignSpeakerToSegment(7);
      ref.now = 4700; t.addSpeakerChange({ position: 3700, speaker: BOB, reason: 'mapped', track: 'tb' });
      assert.strictEqual(t.getSpeakerForSegment(7).id, 'u2');
    });
  });
});
