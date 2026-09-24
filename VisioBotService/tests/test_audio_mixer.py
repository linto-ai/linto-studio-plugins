"""Standalone tests for bot/audio_mixer.py (K4).

  - the mixed output is byte-identical to the legacy one for the nominal case
    (one frame per participant per tick, sum + clip, single-participant
    pass-through) — the legacy mixed path must not move;
  - the per-participant buffer is BOUNDED with drop-oldest and a throttled
    warning (ported back from BotService/bot/AudioMixer.js, lost in the port):
    an unbounded buffer fills faster than the >20 ms tick drains it and caption
    latency drifts by seconds per minute of meeting;
  - the tick CATCHES UP: it drains the frames real time actually made due, so
    the steady state cannot lag, with a hard cap on the burst;
  - `diarization=False` skips the RMS/dominant-speaker pass (per-stream archive
    role) while producing exactly the same audio.

Pure stdlib — audio_mixer.py imports nothing outside it.

Run:  python3 VisioBotService/tests/test_audio_mixer.py
(or via pytest:  pytest VisioBotService/tests/test_audio_mixer.py)
"""
import asyncio
import io
import os
import struct
import sys
import types
from contextlib import redirect_stdout

_HERE = os.path.dirname(os.path.abspath(__file__))
_SVC = os.path.dirname(_HERE)  # VisioBotService/
if _SVC not in sys.path:
    sys.path.insert(0, _SVC)

import bot.audio_mixer as mixer_mod  # noqa: E402
from bot.audio_mixer import (  # noqa: E402
    DROP_WARN_EVERY,
    FRAME_BYTES,
    FRAME_DURATION_S,
    FRAME_SAMPLES,
    MAX_CATCHUP_FRAMES,
    AudioMixer,
    rms_s16le,
)


def _tone(value, samples=FRAME_SAMPLES):
    return struct.pack(f"<{samples}h", *([value] * samples))


def _mixer(**kwargs):
    frames = []
    speakers = []
    mixer = AudioMixer(
        on_frame=frames.append,
        on_speaker_change=speakers.append,
        energy_threshold=300,
        **kwargs,
    )
    return mixer, frames, speakers


# --- nominal mix (must not move) ---------------------------------------------
def test_single_participant_frame_is_passed_through_verbatim():
    mixer, frames, _ = _mixer()
    pcm = _tone(1000)
    mixer.push("alice", pcm, "Alice")
    mixer._tick()
    assert frames == [pcm], "a lone participant's frame must be emitted unchanged"


def test_two_participants_are_summed_and_clipped():
    mixer, frames, _ = _mixer()
    mixer.push("alice", _tone(20000), "Alice")
    mixer.push("bob", _tone(20000), "Bob")
    mixer._tick()
    assert len(frames) == 1
    samples = struct.unpack(f"<{FRAME_SAMPLES}h", frames[0])
    assert set(samples) == {32767}, "the sum must clip at int16 max"

    mixer, frames, _ = _mixer()
    mixer.push("alice", _tone(1000))
    mixer.push("bob", _tone(-400))
    mixer._tick()
    samples = struct.unpack(f"<{FRAME_SAMPLES}h", frames[0])
    assert set(samples) == {600}


def test_dominant_speaker_transition_is_emitted_once():
    mixer, _, speakers = _mixer()
    mixer.push("alice", _tone(5000), "Alice")
    mixer.push("bob", _tone(100), "Bob")
    mixer._tick()
    mixer.push("alice", _tone(5000), "Alice")
    mixer.push("bob", _tone(100), "Bob")
    mixer._tick()
    assert speakers == [{"id": "alice", "name": "Alice"}], speakers


# --- K4: bounded buffers ------------------------------------------------------
def test_buffer_is_bounded_and_keeps_the_freshest_audio():
    mixer, frames, _ = _mixer(buffer_frames=4)
    for i in range(1, 11):  # 10 frames into a 4-frame buffer
        mixer.push("alice", _tone(i * 100), "Alice")
    assert len(mixer.buffers["alice"]) == 4 * FRAME_BYTES
    assert mixer.dropped["alice"] == 6 * FRAME_SAMPLES
    # Drop-OLDEST: what survives is the LAST four frames (700..1000).
    for expected in (700, 800, 900, 1000):
        mixer._tick()
        assert struct.unpack("<h", frames[-1][:2])[0] == expected
    print("ok: bounded buffer drops the oldest audio, keeps the freshest")


def test_unbounded_growth_is_impossible():
    mixer, _, _ = _mixer(buffer_frames=160)
    for _ in range(5000):  # 100 s of audio, drained by nobody
        mixer.push("alice", _tone(500))
    assert len(mixer.buffers["alice"]) == 160 * FRAME_BYTES
    print("ok: a never-drained buffer stays capped instead of growing forever")


def test_overflow_warning_is_throttled():
    mixer, _, _ = _mixer(buffer_frames=1)
    buf = io.StringIO()
    with redirect_stdout(buf):
        for _ in range(200):
            mixer.push("alice", _tone(500), "Alice")
    out = buf.getvalue()
    warnings = out.count("buffer overflow")
    dropped = mixer.dropped["alice"]
    assert dropped == 199 * FRAME_SAMPLES, dropped
    # One line per DROP_WARN_EVERY dropped samples at most — never one per frame.
    assert 0 < warnings <= dropped // DROP_WARN_EVERY + 1, (warnings, dropped)
    assert warnings < 200
    print(f"ok: {dropped} dropped samples produced only {warnings} warning line(s)")


def test_remove_participant_clears_the_drop_counters():
    mixer, _, _ = _mixer(buffer_frames=1)
    for _ in range(5):
        mixer.push("alice", _tone(500), "Alice")
    assert mixer.dropped.get("alice")
    mixer.remove_participant("alice")
    assert "alice" not in mixer.dropped and "alice" not in mixer.buffers


# --- K4: catch-up drain -------------------------------------------------------
def test_run_drains_the_frames_real_time_made_due():
    """The loop period is always > 20 ms; a one-frame tick would then consume
    slower than the 16 kHz production rate and lag forever."""
    mixer, frames, _ = _mixer()

    async def drive():
        # 1 s of audio buffered up front (bounded at 160 frames = 3.2 s).
        for _ in range(50):
            mixer.push("alice", _tone(500), "Alice")
        mixer.start()
        await asyncio.sleep(0.35)
        mixer.stop()

    asyncio.run(drive())
    # ~350 ms of wall time => ~17 frames due. A one-frame-per-iteration tick
    # cannot exceed the number of loop iterations, which the sleep floor caps
    # well below that; the catch-up drain tracks real time instead.
    assert len(frames) >= 12, len(frames)
    assert len(frames) <= 25, len(frames)
    print(f"ok: {len(frames)} frames drained in ~350 ms (real-time tracking)")


def test_catchup_burst_is_capped():
    mixer, frames, _ = _mixer()
    mixer._carry_s = 10.0  # a 10 s stall's worth of debt
    for _ in range(2000):
        mixer.push("alice", _tone(500), "Alice")

    async def drive():
        mixer.start()
        await asyncio.sleep(0.03)
        mixer.stop()

    asyncio.run(drive())
    assert len(frames) <= MAX_CATCHUP_FRAMES + 2, len(frames)
    assert mixer._carry_s == 0.0, "the unpayable debt must be written off"
    print(f"ok: a long stall repays at most {MAX_CATCHUP_FRAMES} frames per iteration")


def test_the_catchup_drain_keeps_the_steady_state_latency_flat():
    """Audio is produced in real time (one 20 ms frame per 20 ms of meeting) while
    the loop period never is: asyncio.sleep(0.02) plus the pure-Python
    unpack/RMS/mix work lands well past 20 ms. A one-frame tick would then drain
    slower than the production rate and the backlog — i.e. the caption latency —
    would grow for the whole meeting.

    Driven on a FAKE clock (a fixed 50 ms loop period) so the assertion is on the
    drain arithmetic and not on the host's load."""
    mixer, frames, _ = _mixer()
    period = 0.050
    iterations = 40
    clock = [0.0]
    produced = [0]
    ticks = [0]
    backlog = []
    real_sleep = asyncio.sleep

    async def fake_sleep(_delay):
        ticks[0] += 1
        clock[0] += period
        # `period` of real time made exactly `period` of audio: push what is due.
        due = int(clock[0] / FRAME_DURATION_S) - produced[0]
        for _ in range(due):
            mixer.push("alice", _tone(500), "Alice")
        produced[0] += due
        backlog.append(len(mixer.buffers.get("alice", b"")) // FRAME_BYTES)
        if ticks[0] >= iterations:
            mixer._running = False
        await real_sleep(0)

    async def drive():
        saved_time, saved_asyncio = mixer_mod.time, mixer_mod.asyncio
        mixer_mod.time = types.SimpleNamespace(monotonic=lambda: clock[0])
        mixer_mod.asyncio = types.SimpleNamespace(
            sleep=fake_sleep,
            create_task=asyncio.create_task,
            CancelledError=asyncio.CancelledError,
        )
        try:
            mixer.start()
            await asyncio.wait_for(mixer._task, timeout=5)
        finally:
            mixer_mod.time, mixer_mod.asyncio = saved_time, saved_asyncio

    asyncio.run(drive())

    expected = iterations * period / FRAME_DURATION_S  # 2.5 frames per iteration
    assert abs(produced[0] - expected) <= 1, (produced[0], expected)
    # Flat: the backlog at the end is the backlog in the middle, both ~one frame.
    assert backlog[-1] <= 3, f"the backlog grew to {backlog[-1]} frames"
    assert backlog[-1] <= backlog[len(backlog) // 2] + 1, backlog
    # ...and essentially everything produced was emitted, none of it shed.
    assert len(frames) >= produced[0] - 3, (len(frames), produced[0])
    assert mixer.dropped.get("alice", 0) == 0
    print(f"ok: {produced[0]} frames in, {len(frames)} out, backlog flat at "
          f"{backlog[-1]} frame(s)")


# --- K2: diarization toggle ---------------------------------------------------
def test_diarization_off_produces_identical_audio_and_no_speaker_events():
    ref, ref_frames, ref_speakers = _mixer()
    off, off_frames, off_speakers = _mixer(diarization=False)
    for mixer in (ref, off):
        mixer.push("alice", _tone(9000), "Alice")
        mixer.push("bob", _tone(-3000), "Bob")
        mixer._tick()
        mixer.push("alice", _tone(120), "Alice")
        mixer._tick()
    assert off_frames == ref_frames, "the archive flow must be the same audio"
    assert ref_speakers, "the legacy path still emits speaker transitions"
    assert off_speakers == [], "per-stream must not pay for the RMS/dominant pass"
    print("ok: diarization=False keeps the audio and drops the speaker pass")


def test_clear_drops_buffered_audio_on_a_role_change():
    mixer, frames, _ = _mixer()
    mixer.push("alice", _tone(500), "Alice")
    mixer.clear()
    mixer._tick()
    assert frames == []
    assert mixer.names.get("alice") == "Alice", "names survive a role change"


def test_rms_of_empty_pcm():
    assert rms_s16le(b"") == 0.0
    assert rms_s16le(_tone(1000)) == 1000.0


# --- speaker-change hysteresis (BOT_SPEAKER_HOLD_MS) ---------------------------
def _ticks(mixer, n, loud, quiet=None):
    """Run n ticks where `loud` dominates (5000) and `quiet` is audible but lower."""
    for _ in range(n):
        mixer.push(loud, _tone(5000), loud.title())
        if quiet:
            mixer.push(quiet, _tone(1000), quiet.title())
        mixer._tick()


def test_a_new_dominant_must_hold_before_the_change_is_emitted():
    mixer, _, speakers = _mixer(speaker_hold_ms=300)
    _ticks(mixer, 5, "alice", "bob")
    assert speakers == [{"id": "alice", "name": "Alice"}], "first speaker is immediate"
    _ticks(mixer, 14, "bob", "alice")  # 280 ms: not yet
    assert len(speakers) == 1, speakers
    _ticks(mixer, 1, "bob", "alice")  # 300 ms reached
    assert speakers[-1] == {"id": "bob", "name": "Bob"}, speakers
    assert len(speakers) == 2


def test_flapping_overlap_emits_no_change():
    mixer, _, speakers = _mixer(speaker_hold_ms=300)
    _ticks(mixer, 1, "alice", "bob")
    for _ in range(50):  # 2 s of alternation every 100 ms
        _ticks(mixer, 5, "bob", "alice")
        _ticks(mixer, 5, "alice", "bob")
    assert speakers == [{"id": "alice", "name": "Alice"}], speakers


def test_hold_zero_restores_the_immediate_switch():
    mixer, _, speakers = _mixer(speaker_hold_ms=0)
    _ticks(mixer, 1, "alice", "bob")
    _ticks(mixer, 1, "bob", "alice")
    assert [s["id"] for s in speakers] == ["alice", "bob"]


def test_hold_comes_from_the_env_with_a_300_ms_default():
    old = os.environ.pop("BOT_SPEAKER_HOLD_MS", None)
    try:
        assert AudioMixer(on_frame=lambda _: None).speaker_hold_ms == 300
        os.environ["BOT_SPEAKER_HOLD_MS"] = "120"
        assert AudioMixer(on_frame=lambda _: None).speaker_hold_ms == 120
        os.environ["BOT_SPEAKER_HOLD_MS"] = "junk"
        assert AudioMixer(on_frame=lambda _: None).speaker_hold_ms == 300
    finally:
        os.environ.pop("BOT_SPEAKER_HOLD_MS", None)
        if old is not None:
            os.environ["BOT_SPEAKER_HOLD_MS"] = old


def test_a_departed_challenger_is_forgotten():
    mixer, _, speakers = _mixer(speaker_hold_ms=300)
    _ticks(mixer, 1, "alice", "bob")
    _ticks(mixer, 10, "bob", "alice")  # 200 ms of challenge
    mixer.remove_participant("bob")
    mixer.push("bob", _tone(5000), "Bob")  # bob rejoins, starts from zero
    mixer.push("alice", _tone(1000), "Alice")
    mixer._tick()
    _ticks(mixer, 5, "bob", "alice")  # 120 ms total since rejoin
    assert len(speakers) == 1, speakers


_TESTS = [
    test_single_participant_frame_is_passed_through_verbatim,
    test_two_participants_are_summed_and_clipped,
    test_dominant_speaker_transition_is_emitted_once,
    test_buffer_is_bounded_and_keeps_the_freshest_audio,
    test_unbounded_growth_is_impossible,
    test_overflow_warning_is_throttled,
    test_remove_participant_clears_the_drop_counters,
    test_run_drains_the_frames_real_time_made_due,
    test_catchup_burst_is_capped,
    test_the_catchup_drain_keeps_the_steady_state_latency_flat,
    test_diarization_off_produces_identical_audio_and_no_speaker_events,
    test_clear_drops_buffered_audio_on_a_role_change,
    test_rms_of_empty_pcm,
    test_a_new_dominant_must_hold_before_the_change_is_emitted,
    test_flapping_overlap_emits_no_change,
    test_hold_zero_restores_the_immediate_switch,
    test_hold_comes_from_the_env_with_a_300_ms_default,
    test_a_departed_challenger_is_forgotten,
]


def main():
    for t in _TESTS:
        t()
    print(f"\nALL {len(_TESTS)} TESTS PASSED")


if __name__ == "__main__":
    main()
