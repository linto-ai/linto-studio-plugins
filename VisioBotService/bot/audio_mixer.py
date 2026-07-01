"""AudioMixer — sum every participant's 16 kHz mono PCM into one stream AND
derive a native-diarization "who is speaking" signal by energy-based VAD.

Each participant's frames (already resampled to 16 kHz mono s16le by the SDK's
rtc.AudioStream) are accumulated per identity. A 20 ms tick (320 samples @ 16 kHz
= 640 bytes) pops one frame's worth from every active participant, sums them in
int32, clips to int16 and emits ONE mixed frame via on_frame(bytes).

On the same tick it computes each contributing participant's RMS energy, picks
the dominant speaker (loudest above the energy threshold) and, on a TRANSITION
only, fires on_speaker_change({"id":…,"name":…}) — or None after a silence grace
period. This ports BotService/bot/AudioMixer.js (the WEB bot reference) so the
native Transcriber path receives the real display name instead of the provider's
internal "Guest-N" diarization label.

numpy is intentionally NOT used — stdlib struct only.
"""
import asyncio
import os
import struct

SAMPLE_RATE = 16000
FRAME_SAMPLES = 320  # 20 ms @ 16 kHz
FRAME_BYTES = FRAME_SAMPLES * 2  # s16le mono
FRAME_DURATION_MS = 20
_FMT = f"<{FRAME_SAMPLES}h"  # explicit little-endian (s16le)

# RMS amplitude above which a participant is considered speaking. Reuses the same
# env knob as the per-stream VAD (BOT_VAD_ENERGY_THRESHOLD, default 300) so both
# native paths share one tuning point. Tuned for s16le speech; below is silence.
DEFAULT_ENERGY_THRESHOLD = 300
# Hold the current speaker this long after they go quiet before emitting a silence
# (null-speaker) transition. Intra-speech pauses are 300–800 ms, so a shorter
# grace would flap the diarization label on every breath. Matches the WEB bot.
DEFAULT_SILENCE_GRACE_MS = 2000


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
    ) -> None:
        self.on_frame = on_frame
        self.on_speaker_change = on_speaker_change
        if energy_threshold is None:
            energy_threshold = int(
                os.environ.get("BOT_VAD_ENERGY_THRESHOLD", str(DEFAULT_ENERGY_THRESHOLD))
            )
        self.energy_threshold = energy_threshold
        self.silence_grace_ms = silence_grace_ms

        self.buffers: dict[str, bytearray] = {}
        self.names: dict[str, str] = {}  # identity -> last-known display name
        self._task: asyncio.Task | None = None
        self._running = False

        # Native diarization state (ported from AudioMixer.js).
        self._current_speaker: dict | None = None  # {"id","name"} | None
        self._silence_ms = 0

    def push(self, identity: str, pcm_bytes: bytes, name: str | None = None) -> None:
        buf = self.buffers.get(identity)
        if buf is None:
            buf = bytearray()
            self.buffers[identity] = buf
        buf.extend(pcm_bytes)
        if name:
            self.names[identity] = name

    def remove_participant(self, identity: str) -> None:
        """Forget a participant that left. Clears the speaker if it was them."""
        self.buffers.pop(identity, None)
        self.names.pop(identity, None)
        if self._current_speaker and self._current_speaker["id"] == identity:
            self._current_speaker = None
            self._silence_ms = 0

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
        self._task = asyncio.create_task(self._run())

    async def _run(self) -> None:
        try:
            while self._running:
                await asyncio.sleep(0.02)
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
            self._update_speaker(None, None)
            return

        max_energy = 0.0
        dominant_id: str | None = None
        dominant_name: str | None = None

        if len(frames) == 1:
            identity, mixed = frames[0]
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

        self._update_speaker(dominant_id, dominant_name)

    def _update_speaker(self, dominant_id, dominant_name) -> None:
        current_id = self._current_speaker["id"] if self._current_speaker else None

        if dominant_id is not None:
            self._silence_ms = 0
            if current_id != dominant_id:
                self._current_speaker = {"id": dominant_id, "name": dominant_name}
                self._emit_speaker(self._current_speaker)
            return

        if current_id is not None:
            # Nobody speaking. Only emit a silence transition after the grace
            # period, and only with more than one participant — a lone speaker's
            # pauses are not a meaningful diarization boundary.
            self._silence_ms += FRAME_DURATION_MS
            if self._silence_ms >= self.silence_grace_ms and len(self.buffers) > 1:
                self._current_speaker = None
                self._silence_ms = 0
                self._emit_speaker(None)

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
