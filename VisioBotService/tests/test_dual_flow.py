"""Standalone tests for the bot side of the DUAL FLOW (K2) and the VAD gate (C2b).

  K2  when the ack grants mixedRecording, the mixer is RE-STARTED in per-stream
      mode as the ARCHIVE flow (diarization off) and its frames go out as MAGIC
      0x02 through enqueue_mixed(); every pump frame is pushed to it UN-GATED,
      BEFORE the VAD gate, so the archive holds the sub-threshold audio the
      legacy recording holds. Without the grant the mixer stays idle, and the
      legacy (non per-stream) role is unchanged: mixed flow, diarization ON.
  C2b the VAD hangover is 800 ms by default (configurable), long enough for the
      provider's end-of-utterance silence timeout to fire between two bursts.
  Every tagged/mixed frame carries the bot's meeting clock (meetingTimeMs).

Runs WITHOUT the heavy runtime deps by stubbing livekit / websockets, like the
sibling tests.

Run:  python3 VisioBotService/tests/test_dual_flow.py
(or via pytest:  pytest VisioBotService/tests/test_dual_flow.py)
"""
import asyncio
import os
import struct
import sys
import types

_HERE = os.path.dirname(os.path.abspath(__file__))
_SVC = os.path.dirname(_HERE)  # VisioBotService/
if _SVC not in sys.path:
    sys.path.insert(0, _SVC)


def _stub(name, **attrs):
    mod = types.ModuleType(name)
    for k, v in attrs.items():
        setattr(mod, k, v)
    sys.modules[name] = mod
    return mod


_lk = _stub("livekit")
_rtc = _stub("livekit.rtc", Room=object, AudioStream=object,
             TrackKind=types.SimpleNamespace(KIND_AUDIO="audio"),
             TrackSource=types.SimpleNamespace(SOURCE_UNKNOWN=0, SOURCE_MICROPHONE=2,
                                               SOURCE_SCREENSHARE_AUDIO=4),
             RoomOptions=object)
_lk.rtc = _rtc
_stub("livekit.api", AccessToken=object, VideoGrants=object)
_stub("websockets", connect=None)

import bot.livekit_bot as livekit_bot_mod  # noqa: E402
from bot.audio_mixer import FRAME_SAMPLES  # noqa: E402
from bot.livekit_bot import DEFAULT_VAD_HANGOVER_MS, LiveKitBot  # noqa: E402


# --- helpers -----------------------------------------------------------------
class _FakeTranscriber:
    def __init__(self, per_stream=False, mixed_recording=False):
        self.per_stream = per_stream
        self.mixed_recording = mixed_recording
        self.ready = True
        self.on_failure = None
        self.on_mode_change = None
        self.bare = []       # legacy enqueue()
        self.tagged = []     # enqueue_tagged(tag, t_ms, pcm)
        self.mixed = []      # enqueue_mixed(t_ms, pcm)

    def enqueue(self, frame):
        self.bare.append(frame)

    def enqueue_tagged(self, tag, t_ms, pcm):
        self.tagged.append((tag, t_ms, pcm))

    def enqueue_mixed(self, t_ms, pcm):
        self.mixed.append((t_ms, pcm))

    def send_participant(self, *a, **k):
        pass

    def send_speaker_change(self, *a, **k):
        pass


class _FakeMixer:
    """Records role changes and the frames pushed in (the real AudioMixer has
    its own suite; here only the WIRING is under test)."""

    def __init__(self):
        self.diarization = True
        self.started = 0
        self.stopped = 0
        self.cleared = 0
        self.running = False
        self.pushed = []

    def start(self):
        self.started += 1
        self.running = True

    def stop(self):
        self.stopped += 1
        self.running = False

    def clear(self):
        self.cleared += 1

    def push(self, identity, pcm, name=None):
        self.pushed.append((identity, pcm))

    def remove_participant(self, ident):
        pass

    def update_name(self, ident, name):
        pass


class _Track:
    sid = "TR_1"
    kind = "audio"


def _make_bot(per_stream=False, mixed_recording=False, hangover_s=0.8):
    bot = LiveKitBot.__new__(LiveKitBot)
    bot._tags = {}
    bot._free_tags = []
    bot._next_tag = 0
    bot._participants = {"alice": "Alice"}
    bot._track_sids = {}
    bot._left = {}
    bot._pumped = set()
    bot._pump_tasks = set()
    bot._pump_by_identity = {}
    bot._vad_state = {}
    bot._departed = {}
    bot._departed_sids = {}
    bot._vad_thr = 300
    bot._vad_hangover_s = hangover_s
    bot._t0 = 0.0
    bot._mixer_role = None
    bot._closing = False
    bot._failing = False
    bot.room_name = "room-1"
    bot.transcriber = _FakeTranscriber(per_stream, mixed_recording)
    bot.mixer = _FakeMixer()
    return bot


def _tone(value, samples=FRAME_SAMPLES):
    return struct.pack(f"<{samples}h", *([value] * samples))


def _install_fake_audio_stream(frames):
    """Make rtc.AudioStream(track, …) yield `frames` then finish."""

    class _Ev:
        def __init__(self, pcm):
            self.frame = types.SimpleNamespace(data=pcm)

    class _Stream:
        def __init__(self, track, sample_rate=None, num_channels=None):
            pass

        def __aiter__(self):
            async def gen():
                for pcm in frames:
                    yield _Ev(pcm)
            return gen()

        async def aclose(self):
            pass

    previous = livekit_bot_mod.rtc.AudioStream
    livekit_bot_mod.rtc.AudioStream = _Stream
    return previous


# --- K2: the mixer's role follows the GRANT ----------------------------------
def test_legacy_grant_runs_the_mixer_with_diarization_on():
    bot = _make_bot(per_stream=False)
    bot._align_mixer()
    assert bot.mixer.running is True
    assert bot.mixer.diarization is True
    assert bot._mixer_role == "mixed"
    print("ok: the legacy mixed path is unchanged (mixer on, diarization on)")


def test_perstream_without_the_recording_grant_leaves_the_mixer_idle():
    bot = _make_bot(per_stream=True, mixed_recording=False)
    bot._align_mixer()
    assert bot.mixer.running is False
    assert bot.mixer.started == 0
    assert bot._mixer_role is None
    print("ok: per-stream with no mixedRecording grant keeps the mixer idle")


def test_perstream_with_the_recording_grant_restarts_the_mixer_without_diarization():
    bot = _make_bot(per_stream=True, mixed_recording=True)
    bot._align_mixer()
    assert bot.mixer.running is True
    assert bot.mixer.diarization is False, "the archive flow must not pay for the RMS pass"
    assert bot._mixer_role == "recording"
    # Idempotent: re-acking the same grant must not restart it.
    bot._align_mixer()
    assert bot.mixer.started == 1
    print("ok: mixedRecording re-starts the mixer as the archive flow")


def test_a_reconnect_that_changes_the_grant_realigns_and_clears_the_mixer():
    bot = _make_bot(per_stream=True, mixed_recording=True)
    bot._align_mixer()
    assert bot._mixer_role == "recording"
    # The reconnect landed on a Transcriber that refused per-stream.
    bot.transcriber.per_stream = False
    bot.transcriber.mixed_recording = False
    bot._on_transcriber_mode_change(False)
    assert bot._mixer_role == "mixed"
    assert bot.mixer.diarization is True
    assert bot.mixer.cleared == 1, "the previous role's buffered audio must not leak"
    print("ok: a differing reconnect grant realigns the mixer role")


def test_a_lost_link_does_not_realign_the_mixer():
    bot = _make_bot(per_stream=True, mixed_recording=True)
    bot._align_mixer()
    bot.transcriber.per_stream = False  # link down clears the effective mode
    bot.transcriber.ready = False
    bot._on_transcriber_mode_change(False)
    assert bot._mixer_role == "recording", "a link loss is not a new grant"
    print("ok: a link loss leaves the mixer alone (the bounded queue absorbs it)")


# --- K2: mixed frames are routed by mode -------------------------------------
def test_mixed_frames_are_routed_by_mode():
    legacy = _make_bot(per_stream=False)
    legacy._align_mixer()
    legacy._on_mixed_frame(b"\x01\x02")
    assert legacy.transcriber.bare == [b"\x01\x02"]
    assert legacy.transcriber.mixed == []

    archive = _make_bot(per_stream=True, mixed_recording=True)
    archive._align_mixer()
    archive._on_mixed_frame(b"\x03\x04")
    assert archive.transcriber.bare == []
    assert len(archive.transcriber.mixed) == 1
    t_ms, pcm = archive.transcriber.mixed[0]
    assert pcm == b"\x03\x04"
    assert isinstance(t_ms, int) and t_ms >= 0, "the archive frame carries the meeting clock"
    print("ok: the mixer's output goes to enqueue()/enqueue_mixed() per mode")


# --- K2: the archive gets EVERY frame, the tagged flow only speech ------------
def test_perstream_pump_feeds_the_archive_ungated():
    bot = _make_bot(per_stream=True, mixed_recording=True, hangover_s=0.0)
    bot._align_mixer()
    loud = _tone(5000)
    quiet = _tone(1)  # below the 300 RMS threshold
    previous = _install_fake_audio_stream([loud, quiet, loud])
    try:
        asyncio.run(bot._pump(_Track(), "alice"))
    finally:
        livekit_bot_mod.rtc.AudioStream = previous

    # The ARCHIVE holds all three frames (sub-threshold audio included), exactly
    # like the legacy recording.
    assert [pcm for _, pcm in bot.mixer.pushed] == [loud, quiet, loud]
    # Only the VAD-active frames were tagged (silence costs no ASR audio).
    assert [pcm for _, _, pcm in bot.transcriber.tagged] == [loud, loud]
    assert {tag for tag, _, _ in bot.transcriber.tagged} == {0}
    print("ok: per-stream archives every frame un-gated and tags only speech")


def test_perstream_without_the_grant_does_not_feed_the_idle_mixer():
    bot = _make_bot(per_stream=True, mixed_recording=False, hangover_s=0.0)
    bot._align_mixer()
    previous = _install_fake_audio_stream([_tone(5000), _tone(1)])
    try:
        asyncio.run(bot._pump(_Track(), "alice"))
    finally:
        livekit_bot_mod.rtc.AudioStream = previous
    assert bot.mixer.pushed == [], "pushing into an idle mixer would grow it forever"
    assert len(bot.transcriber.tagged) == 1
    print("ok: with no mixedRecording grant nothing is pushed into the idle mixer")


def test_legacy_pump_is_unchanged():
    bot = _make_bot(per_stream=False)
    bot._align_mixer()
    frames = [_tone(5000), _tone(1)]
    previous = _install_fake_audio_stream(frames)
    try:
        asyncio.run(bot._pump(_Track(), "alice"))
    finally:
        livekit_bot_mod.rtc.AudioStream = previous
    assert [pcm for _, pcm in bot.mixer.pushed] == frames
    assert bot.transcriber.tagged == []
    assert bot.transcriber.mixed == []
    print("ok: the legacy pump still feeds only the mixer")


def test_pump_drops_frames_for_a_departed_participant():
    bot = _make_bot(per_stream=True, mixed_recording=False, hangover_s=0.0)
    bot._align_mixer()
    bot._left["alice"] = True
    previous = _install_fake_audio_stream([_tone(5000)])
    try:
        asyncio.run(bot._pump(_Track(), "alice"))
    finally:
        livekit_bot_mod.rtc.AudioStream = previous
    assert bot.transcriber.tagged == [], "a late frame must not resurrect the sub-ASR"
    print("ok: a frame for a departed participant is dropped, not re-tagged")


def test_the_wire_shape_survives_a_link_loss():
    """A link loss transiently clears transcriber.per_stream. The producer must
    NOT switch to the legacy bare-PCM shape in the gap: those frames sit in the
    send queue and the reconnected Transcriber (same grant) would decode them as
    garbage audio."""
    bot = _make_bot(per_stream=True, mixed_recording=True, hangover_s=0.0)
    bot._align_mixer()
    bot.transcriber.per_stream = False  # link down, no new grant
    bot.transcriber.ready = False
    loud = _tone(5000)
    previous = _install_fake_audio_stream([loud])
    try:
        asyncio.run(bot._pump(_Track(), "alice"))
    finally:
        livekit_bot_mod.rtc.AudioStream = previous
    assert bot.transcriber.bare == [], "no legacy bare PCM while the link is down"
    assert [pcm for _, _, pcm in bot.transcriber.tagged] == [loud]
    bot._on_mixed_frame(b"\x01\x02")
    assert [pcm for _, pcm in bot.transcriber.mixed] == [b"\x01\x02"]
    assert bot.transcriber.bare == []
    print("ok: the producer keeps the granted wire shape across a link gap")


# --- C2b: the VAD hangover ----------------------------------------------------
def test_vad_hangover_default_is_800ms():
    assert DEFAULT_VAD_HANGOVER_MS == 800
    saved = os.environ.pop("BOT_VAD_HANGOVER_MS", None)
    try:
        assert LiveKitBot._hangover_seconds() == 0.8
        os.environ["BOT_VAD_HANGOVER_MS"] = "1200"
        assert LiveKitBot._hangover_seconds() == 1.2
        os.environ["BOT_VAD_HANGOVER_MS"] = "not-a-number"
        assert LiveKitBot._hangover_seconds() == 0.8, "garbage falls back to the default"
        os.environ["BOT_VAD_HANGOVER_MS"] = "-5"
        assert LiveKitBot._hangover_seconds() == 0.8
    finally:
        os.environ.pop("BOT_VAD_HANGOVER_MS", None)
        if saved is not None:
            os.environ["BOT_VAD_HANGOVER_MS"] = saved
    print(f"ok: the VAD hangover is {DEFAULT_VAD_HANGOVER_MS} ms, env-configurable")


def test_vad_holds_the_gate_open_for_the_hangover():
    bot = _make_bot(per_stream=True, hangover_s=0.8)
    quiet = _tone(1)
    assert bot._vad_active("alice", _tone(5000)) is True
    # Within the hangover the gate stays open: the burst keeps trailing silence,
    # which is what lets the provider close the utterance.
    assert bot._vad_active("alice", quiet) is True
    # Past it, silence is dropped again (the ASR cost model is preserved).
    bot._vad_state["alice"] -= 1.0
    assert bot._vad_active("alice", quiet) is False
    print("ok: the gate stays open for the hangover, then closes again")


# --- the meeting clock --------------------------------------------------------
def test_now_ms_is_monotonic_and_u32():
    bot = _make_bot()
    first = bot._now_ms()
    second = bot._now_ms()
    assert 0 <= first <= second <= 0xFFFFFFFF
    print("ok: the meeting clock is a u32-safe millisecond counter")


def test_stream_key_is_derived_from_the_ingest_url():
    derive = LiveKitBot._derive_stream_key
    assert derive("ws://transcriber:8080/transcriber-ws/sess-1,0") == "sess-1,0"
    assert derive("wss://host/transcriber-ws/sess-1,2/") == "sess-1,2"
    assert derive("ws://host/transcriber-ws/sess-1,2?x=1") == "sess-1,2"
    assert derive("ws://host/transcriber-ws") is None
    assert derive(None) is None
    print("ok: the per-channel stream key is read off the Transcriber ingest URL")


def test_env_minted_identity_is_unique_per_channel():
    """S2: two channels of one session run two bots against the SAME LiveKit room.
    A room-derived identity makes them collide, and LiveKit evicts the older
    participant — the two bots then take turns kicking each other out."""

    class _FakeAT:
        def __init__(self, key, secret):
            pass

        def with_identity(self, identity):
            _FakeAT.identity = identity
            return self

        def with_name(self, *_a, **_k):
            return self

        def with_grants(self, *_a, **_k):
            return self

        def to_jwt(self):
            return "JWT"

    old_at = livekit_bot_mod.AccessToken
    old_vg = livekit_bot_mod.VideoGrants
    livekit_bot_mod.AccessToken = _FakeAT
    livekit_bot_mod.VideoGrants = lambda **_k: object()
    try:
        identities = []
        for key in ("sess-1,0", "sess-1,1"):
            bot = LiveKitBot.__new__(LiveKitBot)
            bot.join_token = None
            bot.api_key = "k"
            bot.api_secret = "s"
            bot.room_name = "room-1"
            bot._stream_key = key
            bot._token()
            identities.append(_FakeAT.identity)
        assert identities[0] != identities[1], identities
        assert all(i.startswith("linto-visio-bot-room-1") for i in identities)
        # No stream key in the URL: the pre-existing room-only identity.
        bot = LiveKitBot.__new__(LiveKitBot)
        bot.join_token = None
        bot.api_key = "k"
        bot.api_secret = "s"
        bot.room_name = "room-1"
        bot._token()
        assert _FakeAT.identity == "linto-visio-bot-room-1"
    finally:
        livekit_bot_mod.AccessToken = old_at
        livekit_bot_mod.VideoGrants = old_vg
    print("ok: the dev env-minted identity is unique per channel")


_TESTS = [
    test_legacy_grant_runs_the_mixer_with_diarization_on,
    test_perstream_without_the_recording_grant_leaves_the_mixer_idle,
    test_perstream_with_the_recording_grant_restarts_the_mixer_without_diarization,
    test_a_reconnect_that_changes_the_grant_realigns_and_clears_the_mixer,
    test_a_lost_link_does_not_realign_the_mixer,
    test_mixed_frames_are_routed_by_mode,
    test_perstream_pump_feeds_the_archive_ungated,
    test_perstream_without_the_grant_does_not_feed_the_idle_mixer,
    test_legacy_pump_is_unchanged,
    test_pump_drops_frames_for_a_departed_participant,
    test_the_wire_shape_survives_a_link_loss,
    test_vad_hangover_default_is_800ms,
    test_vad_holds_the_gate_open_for_the_hangover,
    test_now_ms_is_monotonic_and_u32,
    test_stream_key_is_derived_from_the_ingest_url,
    test_env_minted_identity_is_unique_per_channel,
]


def main():
    for t in _TESTS:
        t()
    print(f"\nALL {len(_TESTS)} TESTS PASSED")


if __name__ == "__main__":
    main()
