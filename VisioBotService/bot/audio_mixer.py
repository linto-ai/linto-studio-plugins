"""AudioMixer — sum every participant's 16 kHz mono PCM into one stream AND
derive a native-diarization "who is speaking" signal by energy-based VAD.

Each participant's frames (already resampled to 16 kHz mono s16le by the SDK's
rtc.AudioStream) are accumulated per identity. A 20 ms tick (320 samples @ 16 kHz
= 640 bytes) pops one frame's worth from every active participant, sums them in
int32, clips to int16 and emits ONE mixed frame via on_frame(bytes).

On the same tick it computes each contributing participant's RMS energy, picks
the dominant speaker (loudest above the energy threshold) and, on a TRANSITION
only, fires on_speaker_change({"id":…,"name":…}) — or None after a silence grace
period. A change from one speaker to another is only emitted once the newcomer
has been dominant for BOT_SPEAKER_HOLD_MS (hysteresis against overlap flapping). This ports BotService/bot/AudioMixer.js (the WEB bot reference) so the
native Transcriber path receives the real display name instead of the provider's
internal "Guest-N" diarization label.

Two properties ported back from that JS reference and lost in the first port:
  - K4 the per-participant buffer is BOUNDED (drop-oldest, throttled warning).
    The tick period is always > 20 ms — the asyncio.sleep floor plus pure-Python
    unpack/RMS/mix work that grows with the participant count — so an unbounded
    buffer is filled faster than it is drained and caption latency drifts by
    seconds per minute of meeting.
  - K4 the tick CATCHES UP: it drains as many frames as real time actually made
    due since the last drain, not exactly one, so the steady state cannot lag.

`diarization` (default True) can be turned off to skip the RMS/dominant-speaker
pass entirely: in per-stream mode the Transcriber derives the speaker from the
tags and discards `speakerChanged`, and this loop is the mixer's most expensive
work — there the mixer only produces the archive (mixedRecording) flow.

numpy is intentionally NOT used — stdlib struct only.
"""
import asyncio
import os
import struct
import time

SAMPLE_RATE = 16000
FRAME_SAMPLES = 320  # 20 ms @ 16 kHz
FRAME_BYTES = FRAME_SAMPLES * 2  # s16le mono
FRAME_DURATION_MS = 20
FRAME_DURATION_S = FRAME_DURATION_MS / 1000.0
_FMT = f"<{FRAME_SAMPLES}h"  # explicit little-endian (s16le)

# RMS amplitude above which a participant is considered speaking. Reuses the same
# env knob as the per-stream VAD (BOT_VAD_ENERGY_THRESHOLD, default 300) so both
# native paths share one tuning point. Tuned for s16le speech; below is silence.
DEFAULT_ENERGY_THRESHOLD = 300
# Hold the current speaker this long after they go quiet before emitting a silence
# (null-speaker) transition. Intra-speech pauses are 300–800 ms, so a shorter
# grace would flap the diarization label on every breath. Matches the WEB bot.
DEFAULT_SILENCE_GRACE_MS = 2000
# Hysteresis on speaker CHANGES: a new dominant speaker must stay dominant this
# long (cumulated 20 ms ticks, uninterrupted by the current speaker taking the
# floor back) before the transition is emitted. Without it, two overlapping
# voices of similar energy flip the label every tick and the Transcriber's
# segments/partials inherit that noise. The FIRST speaker (from nobody) is still
# emitted immediately. Env: BOT_SPEAKER_HOLD_MS; 0 disables the hold.
DEFAULT_SPEAKER_HOLD_MS = 300

# K4: per-participant buffer depth in 20 ms frames (~3.2 s), the JS reference's
# `bufferFrames: 160`. Absorbs the jitter between the SFU's capture cadence and
# the mix tick; past it the OLDEST audio is dropped, so a sustained mismatch
# costs a bounded gap instead of an ever-growing latency.
DEFAULT_BUFFER_FRAMES = 160
# K4: hard cap on the frames one loop iteration may drain. A long stall (GC, a
# blocked loop) must not be repaid as a multi-second burst into the Transcriber;
# the bounded buffers already shed that audio.
MAX_CATCHUP_FRAMES = 25  # 500 ms
# Warn on overflow at most every this many dropped samples (mirrors the JS
# sibling's DROP_WARN_EVERY): every drop is counted, the log is throttled.
DROP_WARN_EVERY = 500


def rms_s16le(pcm: bytes) -> float:
    """Root-mean-square amplitude of s16le mono PCM (0.0 for empty). Pure
    stdlib (struct only) — no audioop/numpy dependency."""
    n = len(pcm) // 2
    if not n:
        return 0.0
    samples = struct.unpack(f"<{n}h", pcm[: n * 2])
    return (sum(s * s for s in samples) / n) ** 0.5


class AudioMixer:
    def __init__(
        self,
        on_frame,
        on_speaker_change=None,
        energy_threshold: int | None = None,
        silence_grace_ms: int = DEFAULT_SILENCE_GRACE_MS,
        buffer_frames: int | None = None,
        diarization: bool = True,
        speaker_hold_ms: int | None = None,
    ) -> None:
        self.on_frame = on_frame
        self.on_speaker_change = on_speaker_change
        if energy_threshold is None:
            energy_threshold = int(
                os.environ.get("BOT_VAD_ENERGY_THRESHOLD", str(DEFAULT_ENERGY_THRESHOLD))
            )
        self.energy_threshold = energy_threshold
        self.silence_grace_ms = silence_grace_ms
        if speaker_hold_ms is None:
            try:
                speaker_hold_ms = int(
                    os.environ.get("BOT_SPEAKER_HOLD_MS", str(DEFAULT_SPEAKER_HOLD_MS))
                )
            except (TypeError, ValueError):
                speaker_hold_ms = DEFAULT_SPEAKER_HOLD_MS
        self.speaker_hold_ms = max(0, speaker_hold_ms)
        if buffer_frames is None:
            try:
                buffer_frames = int(
                    os.environ.get("BOT_MIXER_BUFFER_FRAMES", str(DEFAULT_BUFFER_FRAMES))
                )
            except (TypeError, ValueError):
                buffer_frames = DEFAULT_BUFFER_FRAMES
        if buffer_frames < 1:
            buffer_frames = DEFAULT_BUFFER_FRAMES
        self.buffer_bytes = buffer_frames * FRAME_BYTES
        # Off in per-stream mode: the Transcriber attributes captions by tag there
        # and discards speakerChanged, so the RMS/dominant pass is pure cost.
        self.diarization = diarization

        self.buffers: dict[str, bytearray] = {}
        self.names: dict[str, str] = {}  # identity -> last-known display name
        self.dropped: dict[str, int] = {}  # identity -> samples shed on overflow
        self._last_warned: dict[str, int] = {}
        self._task: asyncio.Task | None = None
        self._running = False
        self._carry_s = 0.0  # real time not yet converted into drained frames

        # Native diarization state (ported from AudioMixer.js).
        self._current_speaker: dict | None = None  # {"id","name"} | None
        self._silence_ms = 0
        # Speaker-change hysteresis: challenger to the current speaker and how
        # long (ms) it has been dominant.
        self._candidate: dict | None = None  # {"id","name"} | None
        self._candidate_ms = 0

    def push(self, identity: str, pcm_bytes: bytes, name: str | None = None) -> None:
        buf = self.buffers.get(identity)
        if buf is None:
            buf = bytearray()
            self.buffers[identity] = buf
        buf.extend(pcm_bytes)
        # K4: BOUNDED, drop-oldest. Keeping the freshest audio bounds the caption
        # latency; an unbounded buffer would just push the lag out forever.
        overflow = len(buf) - self.buffer_bytes
        if overflow > 0:
            overflow += overflow & 1  # never leave the buffer 16-bit misaligned
            del buf[:overflow]
            dropped = self.dropped.get(identity, 0) + overflow // 2
            self.dropped[identity] = dropped
            # Throttled: a sustained capture/drain mismatch is the only way to
            # accumulate drops, and a transcript gap can be localized from it.
            if dropped - self._last_warned.get(identity, 0) >= DROP_WARN_EVERY:
                self._last_warned[identity] = dropped
                print(
                    f"AudioMixer: WARNING — participant "
                    f"{self.names.get(identity, identity)} buffer overflow, "
                    f"{dropped} sample(s) dropped (capture faster than the mix drain)",
                    flush=True,
                )
        if name:
            self.names[identity] = name

    def remove_participant(self, identity: str) -> None:
        """Forget a participant that left. Clears the speaker if it was them."""
        self.buffers.pop(identity, None)
        self.names.pop(identity, None)
        self.dropped.pop(identity, None)
        self._last_warned.pop(identity, None)
        if self._current_speaker and self._current_speaker["id"] == identity:
            self._current_speaker = None
            self._silence_ms = 0
        if self._candidate and self._candidate["id"] == identity:
            self._reset_candidate()

    def clear(self) -> None:
        """Drop every buffered sample, keeping the participant names.

        Used when the mixer changes ROLE mid-call (legacy mixed flow <-> the
        per-stream archive flow after a reconnect granted differently): the
        buffered audio belongs to the previous role's stream and would be
        prepended to the new one."""
        self.buffers.clear()
        self.dropped.clear()
        self._last_warned.clear()
        self._carry_s = 0.0

    def update_name(self, identity: str, name: str) -> None:
        """Refresh the memorised display name (e.g. participant renamed mid-call).
        Re-emits the current speaker transition if the live speaker is the one
        being renamed, so captions pick up the new name without a turn change."""
        if not name:
            return
        self.names[identity] = name
        if self._current_speaker and self._current_speaker["id"] == identity:
            self._current_speaker = {"id": identity, "name": name}
            self._emit_speaker(self._current_speaker)

    def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._silence_ms = 0
        self._carry_s = 0.0
        self._task = asyncio.create_task(self._run())

    async def _run(self) -> None:
        try:
            last = time.monotonic()
            while self._running:
                await asyncio.sleep(FRAME_DURATION_S)
                now = time.monotonic()
                self._carry_s += now - last
                last = now
                # K4: drain what real time made DUE, not exactly one frame. The
                # loop period is always > 20 ms (sleep floor + mix work), so a
                # one-frame tick consumes strictly slower than the 16 kHz
                # production rate and the backlog only ever grows.
                due = int(self._carry_s / FRAME_DURATION_S)
                if due <= 0:
                    continue
                if due > MAX_CATCHUP_FRAMES:
                    due = MAX_CATCHUP_FRAMES
                    self._carry_s = 0.0  # write the rest of the debt off
                else:
                    self._carry_s -= due * FRAME_DURATION_S
                for _ in range(due):
                    self._tick()
        except asyncio.CancelledError:
            pass

    def _tick(self) -> None:
        frames: list[tuple[str, bytes]] = []
        for identity, buf in list(self.buffers.items()):
            if len(buf) >= FRAME_BYTES:
                frames.append((identity, bytes(buf[:FRAME_BYTES])))
                del buf[:FRAME_BYTES]

        if not frames:
            # No audio this tick: still let the silence grace run (matches the JS
            # mixAndEmit, which calls _updateSpeaker(null) every tick), but emit no
            # mixed frame.
            if self.diarization:
                self._update_speaker(None, None)
            return

        max_energy = 0.0
        dominant_id: str | None = None
        dominant_name: str | None = None

        if len(frames) == 1:
            identity, mixed = frames[0]
            if self.diarization:
                energy = rms_s16le(mixed)
                if energy > self.energy_threshold:
                    max_energy = energy
                    dominant_id = identity
                    dominant_name = self.names.get(identity, identity)
        else:
            acc = [0] * FRAME_SAMPLES
            for identity, chunk in frames:
                samples = struct.unpack(_FMT, chunk)
                for i in range(FRAME_SAMPLES):
                    acc[i] += samples[i]
                if self.diarization:
                    energy = rms_s16le(chunk)
                    if energy > self.energy_threshold and energy > max_energy:
                        max_energy = energy
                        dominant_id = identity
                        dominant_name = self.names.get(identity, identity)
            clipped = [
                32767 if v > 32767 else (-32768 if v < -32768 else v) for v in acc
            ]
            mixed = struct.pack(_FMT, *clipped)

        try:
            self.on_frame(mixed)
        except Exception:  # noqa: BLE001
            pass

        if self.diarization:
            self._update_speaker(dominant_id, dominant_name)

    def _update_speaker(self, dominant_id, dominant_name) -> None:
        current_id = self._current_speaker["id"] if self._current_speaker else None

        if dominant_id is not None:
            self._silence_ms = 0
            if current_id == dominant_id:
                # The current speaker holds the floor: any challenger starts over.
                self._reset_candidate()
                return
            if current_id is None or self.speaker_hold_ms <= 0:
                # Nobody was speaking (or hold disabled): switch immediately.
                self._switch_speaker(dominant_id, dominant_name)
                return
            if self._candidate is None or self._candidate["id"] != dominant_id:
                self._candidate = {"id": dominant_id, "name": dominant_name}
                self._candidate_ms = 0
            self._candidate_ms += FRAME_DURATION_MS
            if self._candidate_ms >= self.speaker_hold_ms:
                self._switch_speaker(dominant_id, dominant_name)
            return

        if current_id is not None:
            # Nobody speaking. Only emit a silence transition after the grace
            # period, and only with more than one participant — a lone speaker's
            # pauses are not a meaningful diarization boundary.
            self._silence_ms += FRAME_DURATION_MS
            if self._silence_ms >= self.silence_grace_ms and len(self.buffers) > 1:
                self._current_speaker = None
                self._silence_ms = 0
                self._reset_candidate()
                self._emit_speaker(None)

    def _switch_speaker(self, speaker_id, speaker_name) -> None:
        self._current_speaker = {"id": speaker_id, "name": speaker_name}
        self._reset_candidate()
        self._emit_speaker(self._current_speaker)

    def _reset_candidate(self) -> None:
        self._candidate = None
        self._candidate_ms = 0

    def _emit_speaker(self, speaker: dict | None) -> None:
        if self.on_speaker_change is None:
            return
        try:
            self.on_speaker_change(speaker)
        except Exception:  # noqa: BLE001
            pass

    def stop(self) -> None:
        self._running = False
        if self._task is not None:
            self._task.cancel()
            self._task = None
        self._current_speaker = None
        self._silence_ms = 0
        self._reset_candidate()
        self._carry_s = 0.0
