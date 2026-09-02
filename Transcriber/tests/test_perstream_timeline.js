/**
 * C2 — per-stream audio-clock -> meeting-clock map.
 *
 * The bot VAD-gates each participant's stream, so a sub-ASR only ever hears
 * speech bursts spliced end to end: every timestamp the provider returns is
 * relative to THAT spliced audio, not to the meeting. A caption from the second
 * burst of a conversation was therefore published as if it had been spoken
 * right after the first one, however long the silence in between.
 *
 * The map is built from the per-frame `meetingTimeMs` the per-stream WS demux
 * forwards to transcribe(), and is applied at publication. What is pinned here:
 *   - a burst preceded by an elided gap is republished MEETING-relative (the
 *     gap is added back to start AND end), while a caption inside the first
 *     burst is untouched;
 *   - an ASR with NO map (every legacy caller: SRT, RTMP, mixed WS) publishes
 *     byte-for-byte unchanged timestamps;
 *   - a meetingTimeMs that goes BACKWARDS (bot restart, u32 wrap) abandons the
 *     map in favour of identity timestamps instead of producing negative gaps;
 *   - a NON-advancing meetingTimeMs adds no gap and does not disable the map;
 *   - a segment STRADDLING a breakpoint keeps its DURATION: one gap, resolved
 *     from the position the segment ends at, is added to both of its ends
 *     (providers that report `start` as the previous final's end — linto,
 *     openai_streaming — sit before the breakpoint while their end sits after);
 *   - the map is bound to the PROVIDER SESSION: a provider that re-enters its
 *     own start() (a linto WS-error reconnect, an openai_streaming Realtime
 *     re-session) reseeds it, exactly as a wrapper-level resume() does.
 *
 * Same plumbing as test_perstream_golden.js: mocked live-srt-lib + neutral
 * logger, the real ASR/index.js driven against FakeTranscriber by emitting
 * provider events. SAMPLE_RATE/BYTES_PER_SAMPLE are set to the real ingest
 * format (16 kHz mono s16le) so a frame duration is readable: 3200 bytes = 100 ms.
 */

const assert = require('assert');
const { describe, it, before, after } = require('mocha');
const { setupMocks, fromTranscriber } = require('./helpers/asr_mocks');

const FRAME_BYTES = 3200;   // 100 ms at 16 kHz mono s16le
const FRAME_MS = 100;

describe('C2 per-stream timeline map (audio clock -> meeting clock)', () => {
  let ASR, teardown;
  const ORIG = {};

  before(() => {
    for (const k of ['SAMPLE_RATE', 'BYTES_PER_SAMPLE', 'MIN_AUDIO_BUFFER']) ORIG[k] = process.env[k];
    // Real ingest format, so _bytesToMs is the honest 100 ms per 3200-byte frame.
    process.env.SAMPLE_RATE = '16000';
    process.env.BYTES_PER_SAMPLE = '2';
    process.env.MIN_AUDIO_BUFFER = '1'; // 32-byte threshold: every frame is forwarded at once
    teardown = setupMocks({
      invalidate: [fromTranscriber('ASR/index.js'), fromTranscriber('ASR/fake/index.js')],
      mockWs: false,
      circularBuffer: true,
    });
    ASR = require('../ASR/index.js');
  });

  after(() => {
    if (teardown) teardown();
    for (const [k, v] of Object.entries(ORIG)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const session = { id: 'sess' };
  function makeChannel() {
    return {
      id: 'chan',
      enableLiveTranscripts: false, // forces FakeTranscriber
      keepAudio: false,
      transcriberProfile: { config: { type: 'fake', languages: [] } },
      translations: [],
    };
  }

  async function makeAsr(options = {}) {
    const asr = new ASR(session, makeChannel(), options);
    await new Promise(r => setImmediate(r));
    await asr._transitionLock;
    return asr;
  }

  const frame = () => Buffer.alloc(FRAME_BYTES, 1);
  const near = (actual, expected, what) =>
    assert.ok(Math.abs(actual - expected) < 1e-6, `${what}: expected ~${expected}, got ${actual}`);

  it('rebases a burst that follows an elided silence onto the meeting clock', async () => {
    const asr = await makeAsr({ participantId: 'u1', participantName: 'Alice' });
    const finals = [];
    asr.on('final', t => finals.push(t));

    // Burst 1: two contiguous frames (audio 0..200 ms, meeting 0..200 ms).
    asr.transcribe(frame(), 0);
    asr.transcribe(frame(), FRAME_MS);
    // 5 s of silence the bot elided, then burst 2 (audio 200..300 ms).
    asr.transcribe(frame(), FRAME_MS * 2 + 5000);

    assert.strictEqual(asr.timeline.breaks.length, 1, 'exactly one breakpoint recorded');
    assert.strictEqual(asr.timeline.breaks[0].audioMs, 200);
    assert.strictEqual(asr.timeline.breaks[0].gapMs, 5000);

    // A caption inside burst 1 is BEFORE the breakpoint: untouched.
    asr.provider.emit('transcribed', { text: 'first', isPrimary: true, start: 0.05, end: 0.15 });
    near(finals[0].start, 0.05, 'burst-1 start');
    near(finals[0].end, 0.15, 'burst-1 end');

    // A caption inside burst 2 is AFTER it: the 5 s gap is added back to both ends.
    asr.provider.emit('transcribed', { text: 'second', isPrimary: true, start: 0.20, end: 0.28 });
    near(finals[1].start, 5.20, 'burst-2 start is meeting-relative');
    near(finals[1].end, 5.28, 'burst-2 end is meeting-relative');
  });

  it('applies the same rebase to partials', async () => {
    const asr = await makeAsr({ participantId: 'u1', participantName: 'Alice' });
    const partials = [];
    asr.on('partial', t => partials.push(t));
    asr.transcribe(frame(), 0);
    asr.transcribe(frame(), FRAME_MS + 2000);   // 2 s elided before the 2nd frame

    asr.provider.emit('transcribing', { text: 'hey', isPrimary: true, start: 0.10, end: 0.19 });
    near(partials[0].start, 2.10, 'partial start rebased');
    near(partials[0].end, 2.19, 'partial end rebased');
  });

  it('an ASR with no map publishes byte-for-byte unchanged timestamps (legacy)', async () => {
    const asr = await makeAsr({}); // legacy: no participant, and no meetingTimeMs below
    const finals = [];
    asr.on('final', t => finals.push(t));

    // Exactly the legacy call shape: transcribe(buffer), no meeting clock.
    asr.transcribe(frame());
    asr.transcribe(frame());
    assert.strictEqual(asr.timeline, null, 'no map is ever built for a legacy caller');

    asr.provider.emit('transcribed', { text: 'a', isPrimary: true, start: 12.5, end: 13.75 });
    assert.strictEqual(finals[0].start, 12.5);
    assert.strictEqual(finals[0].end, 13.75);

    // Non-numeric / absent timestamps are left alone too (no NaN injection).
    asr.provider.emit('transcribed', { text: 'b', isPrimary: true });
    assert.strictEqual('start' in finals[1], false);
  });

  it('a per-stream ASR before any gap is also byte-for-byte unchanged', async () => {
    const asr = await makeAsr({ participantId: 'u1', participantName: 'Alice' });
    const finals = [];
    asr.on('final', t => finals.push(t));
    asr.transcribe(frame(), 0);
    asr.transcribe(frame(), FRAME_MS);     // contiguous: nothing elided
    assert.strictEqual(asr.timeline.breaks.length, 0);
    asr.provider.emit('transcribed', { text: 'a', isPrimary: true, start: 0.125, end: 0.175 });
    assert.strictEqual(finals[0].start, 0.125, 'no breakpoint -> exact passthrough');
    assert.strictEqual(finals[0].end, 0.175);
  });

  it('a backwards meetingTimeMs (bot restart / u32 wrap) falls back to identity', async () => {
    const asr = await makeAsr({ participantId: 'u1', participantName: 'Alice' });
    const finals = [];
    asr.on('final', t => finals.push(t));

    asr.transcribe(frame(), 0);
    asr.transcribe(frame(), FRAME_MS + 3000);   // a real 3 s gap is recorded
    assert.strictEqual(asr.timeline.breaks.length, 1);
    assert.strictEqual(asr.timeline.disabled, false);

    // The bot restarts: its clock rewinds. A negative gap is the only thing this
    // could produce, so the map is abandoned instead.
    asr.transcribe(frame(), 10);
    assert.strictEqual(asr.timeline.disabled, true, 'map abandoned, not corrupted');

    asr.provider.emit('transcribed', { text: 'after restart', isPrimary: true, start: 0.30, end: 0.40 });
    assert.strictEqual(finals[0].start, 0.30, 'identity mapping once disabled');
    assert.strictEqual(finals[0].end, 0.40);

    // A further frame does not resurrect the map.
    asr.transcribe(frame(), 99999);
    assert.strictEqual(asr.timeline.breaks.length, 1, 'no breakpoint appended after the fallback');
  });

  it('a non-advancing meetingTimeMs adds no gap and keeps the map alive', async () => {
    const asr = await makeAsr({ participantId: 'u1', participantName: 'Alice' });
    const finals = [];
    asr.on('final', t => finals.push(t));

    asr.transcribe(frame(), 0);
    asr.transcribe(frame(), 0);   // same stamp twice: advance 0, so gap would be negative
    asr.transcribe(frame(), 0);

    assert.strictEqual(asr.timeline.disabled, false, 'a stalled clock is not a rewind');
    assert.strictEqual(asr.timeline.breaks.length, 0, 'no gap invented');

    asr.provider.emit('transcribed', { text: 'x', isPrimary: true, start: 0.10, end: 0.20 });
    assert.strictEqual(finals[0].start, 0.10);
    assert.strictEqual(finals[0].end, 0.20);

    // The map still works afterwards: a real gap is still picked up.
    asr.transcribe(frame(), 4000);
    assert.strictEqual(asr.timeline.breaks.length, 1);
  });

  it('audio dropped by a pause never counts as audio the provider heard', async () => {
    const asr = await makeAsr({ participantId: 'u1', participantName: 'Alice' });
    asr.transcribe(frame(), 0);
    const forwarded = asr.timeline.audioMs;
    await asr.pause();
    assert.strictEqual(asr.timeline.pendingMs, 0, 'buffered-but-dropped audio is discounted');
    asr.transcribe(frame(), 5000);  // dropped while paused: must not move the clock
    assert.strictEqual(asr.timeline.audioMs, forwarded);
    assert.strictEqual(asr.timeline.breaks.length, 0, 'a dropped frame notes no meeting time');
  });

  // A resume opens a NEW provider session: provider.start() resets `startedAt`
  // (so the resumed captions carry a fresh astart) and the provider's result
  // timestamps restart from 0 on a fresh audio clock. Keeping the map across
  // that boundary charged the whole pause duration as an elided gap to captions
  // whose astart had ALREADY moved past it — the pause was counted twice — and
  // left breakpoints at audio positions the new session never reaches.
  it('a resume reseeds the map so the pause is never charged to the resumed captions', async () => {
    const asr = await makeAsr({ participantId: 'u1', participantName: 'Alice' });
    const finals = [];
    asr.on('final', t => finals.push(t));
    asr.transcribe(frame(), 0);
    asr.transcribe(frame(), FRAME_MS + 3000);   // a real VAD gap before the pause
    assert.strictEqual(asr.timeline.breaks.length, 1, 'precondition: a map was built');

    await asr.pause();
    await asr.resume();
    assert.strictEqual(asr.timeline, null, "the previous provider session's map is dropped");

    // The bot's meeting clock kept running across the (here 60 s) pause.
    asr.transcribe(frame(), 60000);
    asr.transcribe(frame(), 60000 + FRAME_MS);
    assert.strictEqual(asr.timeline.breaks.length, 0, 'the pause itself is not a VAD gap');
    assert.strictEqual(asr.timeline.cumulativeGapMs, 0, 'the map is reseeded, not resumed');

    asr.provider.emit('transcribed', { text: 'after the pause', isPrimary: true, start: 0.10, end: 0.20 });
    near(finals[finals.length - 1].start, 0.10, 'a resumed caption is anchored on the NEW astart');
    near(finals[finals.length - 1].end, 0.20, 'a resumed caption end is not inflated either');
  });

  // A breakpoint is recorded at `audioMs + pendingMs` — the END of all pre-gap
  // audio, which includes the bot's VAD HANGOVER tail. Providers that report a
  // result's `start` as the PREVIOUS final's end (ASR/linto/index.js,
  // ASR/openai_streaming/index.js) therefore hand us a start that lies BEFORE
  // the breakpoint while its end lies after it. Resolving the gap separately for
  // each end added it to `end` only: the caption was published minutes too early
  // AND its duration was inflated by the whole elided silence (a 30 s utterance
  // became a 25-minute one). One gap, resolved from the position the segment
  // ENDS at, is added to both ends.
  it('preserves the DURATION of a segment that straddles a breakpoint', async () => {
    const asr = await makeAsr({ participantId: 'u1', participantName: 'Alice' });
    const finals = [];
    asr.on('final', t => finals.push(t));

    // Burst 1: three contiguous frames (audio 0..300 ms). Then 5 s elided.
    asr.transcribe(frame(), 0);
    asr.transcribe(frame(), FRAME_MS);
    asr.transcribe(frame(), FRAME_MS * 2);
    asr.transcribe(frame(), FRAME_MS * 3 + 5000);
    assert.deepStrictEqual(asr.timeline.breaks, [{ audioMs: 300, gapMs: 5000 }]);

    // The provider reports a 150 ms utterance whose start is the previous
    // final's end (0.20 s, inside the hangover tail) and whose end is 0.35 s.
    asr.provider.emit('transcribed', { text: 'straddles', isPrimary: true, start: 0.20, end: 0.35 });

    near(finals[0].start, 5.20, 'start is moved by the same gap as the end');
    near(finals[0].end, 5.35, 'end lands in the burst the segment belongs to');
    near(finals[0].end - finals[0].start, 0.15, 'the 150 ms utterance stays 150 ms long');
  });

  it('applies the same single gap to a straddling PARTIAL', async () => {
    const asr = await makeAsr({ participantId: 'u1', participantName: 'Alice' });
    const partials = [];
    asr.on('partial', t => partials.push(t));
    asr.transcribe(frame(), 0);
    asr.transcribe(frame(), FRAME_MS);
    asr.transcribe(frame(), FRAME_MS * 2 + 2000);
    assert.deepStrictEqual(asr.timeline.breaks, [{ audioMs: 200, gapMs: 2000 }]);

    asr.provider.emit('transcribing', { text: 'strad', isPrimary: true, start: 0.15, end: 0.24 });
    near(partials[0].start, 2.15, 'partial start');
    near(partials[0].end, 2.24, 'partial end');
    near(partials[0].end - partials[0].start, 0.09, 'partial duration preserved');
  });

  it('a segment carrying only a start (no end) still resolves its own gap', async () => {
    const asr = await makeAsr({ participantId: 'u1', participantName: 'Alice' });
    const finals = [];
    asr.on('final', t => finals.push(t));
    asr.transcribe(frame(), 0);
    asr.transcribe(frame(), FRAME_MS + 4000);
    asr.provider.emit('transcribed', { text: 'start only', isPrimary: true, start: 0.15 });
    near(finals[0].start, 4.15, 'the start is rebased from its own position');
    assert.strictEqual('end' in finals[0], false, 'no end is invented');
  });

  // resume() is NOT the only thing that opens a new provider session: ASR/linto
  // reconnects itself on every WS error, and ASR/openai_streaming re-enters
  // start() on a routine Realtime session-cap re-session. Both reset `startedAt`
  // and restart their reported clock at 0 without the wrapper ever knowing, so a
  // surviving map charges the whole previously-elided silence on top of an
  // `astart` that has already moved past it.
  describe('a provider that restarts ITSELF reseeds the map', () => {
    it('reseeds on the next frame, so nothing is charged twice', async () => {
      const asr = await makeAsr({ participantId: 'u1', participantName: 'Alice' });
      const finals = [];
      asr.on('final', t => finals.push(t));

      asr.transcribe(frame(), 0);
      asr.transcribe(frame(), FRAME_MS + 5000);
      assert.strictEqual(asr.timeline.breaks.length, 1, 'precondition: a map was built');
      assert.strictEqual(asr.timeline.cumulativeGapMs, 5000);
      const epoch = asr.timeline.providerStartedAt;
      assert.ok(epoch, 'the map is bound to the provider session it was built on');

      // The provider re-entered its own start(): astart moved forward and its
      // audio clock restarted at 0. Nothing told the wrapper.
      asr.provider.startedAt = new Date(Date.parse(epoch) + 1000).toISOString();

      asr.transcribe(frame(), 60000);
      assert.strictEqual(asr.timeline.breaks.length, 0, "the previous session's breakpoints are gone");
      assert.strictEqual(asr.timeline.cumulativeGapMs, 0, 'the elided silence is not charged again');
      assert.strictEqual(asr.timeline.providerStartedAt, asr.provider.startedAt,
        'the fresh map is bound to the NEW provider session');

      asr.transcribe(frame(), 60000 + FRAME_MS);
      asr.provider.emit('transcribed', { text: 'after the restart', isPrimary: true, start: 0.40, end: 0.50 });
      near(finals[finals.length - 1].start, 0.40, 'anchored on the NEW astart, unshifted');
      near(finals[finals.length - 1].end, 0.50, 'and not inflated either');
    });

    it('reseeds at publication too, before any new frame arrives', async () => {
      const asr = await makeAsr({ participantId: 'u1', participantName: 'Alice' });
      const finals = [];
      asr.on('final', t => finals.push(t));
      asr.transcribe(frame(), 0);
      asr.transcribe(frame(), FRAME_MS + 5000);
      const epoch = asr.timeline.providerStartedAt;

      asr.provider.startedAt = new Date(Date.parse(epoch) + 1000).toISOString();
      // The very first result of the new provider session, no frame in between.
      asr.provider.emit('transcribed', { text: 'first of the new session', isPrimary: true, start: 0.40, end: 0.55 });

      assert.strictEqual(asr.timeline, null, 'the stale map was dropped, not applied');
      near(finals[finals.length - 1].start, 0.40, 'identity until the map is rebuilt');
      near(finals[finals.length - 1].end, 0.55);
    });

    it('an UNCHANGED provider session keeps its map (no spurious reseed)', async () => {
      const asr = await makeAsr({ participantId: 'u1', participantName: 'Alice' });
      const finals = [];
      asr.on('final', t => finals.push(t));
      asr.transcribe(frame(), 0);
      asr.transcribe(frame(), FRAME_MS + 5000);
      const breaks = asr.timeline.breaks;

      asr.transcribe(frame(), FRAME_MS * 2 + 5000);
      asr.provider.emit('transcribed', { text: 'same session', isPrimary: true, start: 0.15, end: 0.25 });

      assert.strictEqual(asr.timeline.breaks, breaks, 'the very same map object survives');
      assert.strictEqual(asr.timeline.cumulativeGapMs, 5000);
      near(finals[finals.length - 1].start, 5.15, 'the gap is still applied');
      near(finals[finals.length - 1].end, 5.25);
    });
  });

  // The overflow bucket (`${ck}#255`) is fed by every capped participant at
  // once, so its incoming meetingTimeMs interleaves and goes backwards on nearly
  // every frame. It must not even try to build a map.
  it('a shared (overflow) ASR builds no map and logs no wrap warning', async () => {
    const asr = await makeAsr({ participantId: 'overflow', participantName: 'Participants', sharedStream: true });
    const warns = [];
    asr.logger.warn = (msg) => warns.push(msg);
    const finals = [];
    asr.on('final', t => finals.push(t));

    // Three participants interleaving their own meeting clocks through one ASR.
    asr.transcribe(frame(), 5000);
    asr.transcribe(frame(), 1000);
    asr.transcribe(frame(), 9000);
    asr.transcribe(frame(), 2000);

    assert.strictEqual(asr.timeline, null, 'no timeline at all for a shared stream');
    assert.deepStrictEqual(warns, [], 'no misleading "bot restart or u32 wrap" WARN');

    asr.provider.emit('transcribed', { text: 'mixed', isPrimary: true, start: 1.25, end: 1.75 });
    near(finals[0].start, 1.25, 'identity timestamps (accepted degraded mode)');
    near(finals[0].end, 1.75, 'identity timestamps (accepted degraded mode)');
  });

  it('a DEDICATED sub-ASR keeps the backwards-clock diagnostic', async () => {
    const asr = await makeAsr({ participantId: 'u1', participantName: 'Alice' });
    const warns = [];
    asr.logger.warn = (msg) => warns.push(msg);
    asr.transcribe(frame(), 0);
    asr.transcribe(frame(), FRAME_MS);
    asr.transcribe(frame(), 10);                // genuinely backwards: bot restart
    assert.strictEqual(asr.timeline.disabled, true);
    assert.strictEqual(warns.length, 1, 'the WARN still fires where it means something');
    assert.ok(/backwards/.test(warns[0]));
  });

  it('the breakpoint lookup is monotone across many gaps', async () => {
    const asr = await makeAsr({ participantId: 'u1', participantName: 'Alice' });
    const finals = [];
    asr.on('final', t => finals.push(t));

    // 4 bursts of one frame each, separated by 1 s, 2 s and 3 s of elided silence.
    let meeting = 0;
    asr.transcribe(frame(), meeting);
    for (const gap of [1000, 2000, 3000]) {
      meeting += FRAME_MS + gap;
      asr.transcribe(frame(), meeting);
    }
    assert.deepStrictEqual(
      asr.timeline.breaks,
      [
        { audioMs: 100, gapMs: 1000 },
        { audioMs: 200, gapMs: 3000 },
        { audioMs: 300, gapMs: 6000 },
      ],
      'cumulative gaps, appended in increasing audio position');

    // One caption per burst: each carries the cumulative gap in force at its
    // own audio position.
    for (const [start, expected] of [[0.05, 0.05], [0.15, 1.15], [0.25, 3.25], [0.35, 6.35]]) {
      asr.provider.emit('transcribed', { text: 't', isPrimary: true, start, end: start + 0.01 });
      near(finals[finals.length - 1].start, expected, `caption at audio ${start}s`);
    }
  });
});
