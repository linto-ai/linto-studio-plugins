"""Standalone tests for the native bot's TRACK SELECTION and participant
teardown:

  C7  only the participant's MICROPHONE publication is pumped (screenshare audio
      lives on the same `kind` and a shared tab publishes both), and a pump is
      deduped by IDENTITY as well as by track sid — two concurrent pumps under one
      identity produce at 2x real time (one tag / one mixer bucket, two producers).
  C10 the participant tag goes back into the pool only once that participant's
      pump is DEAD, never while it is still draining its stream.
  C11 a frame that lands after the disconnect gets NO tag, so the Transcriber
      cannot lazily re-create the sub-ASR the 'leave' just tore down.
  + the room "disconnected" handler (a terminated LiveKit session must not leave
    an undisposed zombie bot).

Runs WITHOUT the heavy runtime deps by stubbing livekit / websockets, like the
sibling tests.

Run:  python3 VisioBotService/tests/test_track_selection.py
(or via pytest:  pytest VisioBotService/tests/test_track_selection.py)
"""
import asyncio
import os
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


_TRACK_KIND = types.SimpleNamespace(KIND_AUDIO="audio", KIND_VIDEO="video")
# The REAL enum: the mic/screenshare distinction is NOT in TrackKind.
_TRACK_SOURCE = types.SimpleNamespace(
    SOURCE_UNKNOWN=0,
    SOURCE_CAMERA=1,
    SOURCE_MICROPHONE=2,
    SOURCE_SCREENSHARE=3,
    SOURCE_SCREENSHARE_AUDIO=4,
)

_lk = _stub("livekit")
_rtc = _stub("livekit.rtc", Room=object, AudioStream=object,
             TrackKind=_TRACK_KIND, TrackSource=_TRACK_SOURCE, RoomOptions=object)
_lk.rtc = _rtc
_stub("livekit.api", AccessToken=object, VideoGrants=object)
_stub("websockets", connect=None)

import bot.livekit_bot as livekit_bot_mod  # noqa: E402
from bot.livekit_bot import LiveKitBot  # noqa: E402


def _patch_rtc():
    """Point the module's `rtc` at OUR enums.

    The whole suite shares one process and every test module stubs `livekit`, so
    whichever stub was imported first wins. Patch the module object bot.livekit_bot
    actually holds, per test, instead of relying on import order."""
    livekit_bot_mod.rtc.TrackKind = _TRACK_KIND
    livekit_bot_mod.rtc.TrackSource = _TRACK_SOURCE


# --- helpers -----------------------------------------------------------------
class _RecordingTranscriber:
    def __init__(self, per_stream=False, mixed_recording=False):
        self.per_stream = per_stream
        self.mixed_recording = mixed_recording
        self.on_failure = None
        self.calls = []

    def send_participant(self, action, pid, name, tag=None):
        self.calls.append((action, pid, name, tag))


class _NoopMixer:
    def remove_participant(self, ident):
        pass

    def update_name(self, ident, name):
        pass


class _P:
    def __init__(self, identity, name=None, publications=()):
        self.identity = identity
        self.name = name
        self.track_publications = {i: p for i, p in enumerate(publications)}


class _Pub:
    """Stand-in for RemoteTrackPublication (source lives HERE, not on the track)."""

    def __init__(self, source, track=None):
        self.source = source
        self.track = track


class _Track:
    def __init__(self, sid, kind=_TRACK_KIND.KIND_AUDIO):
        self.sid = sid
        self.kind = kind


def _make_bot(per_stream=False, mixed_recording=False):
    _patch_rtc()
    bot = LiveKitBot.__new__(LiveKitBot)
    bot._tags = {}
    bot._free_tags = []
    bot._next_tag = 0
    bot._participants = {}
    bot._track_sids = {}
    bot._left = {}
    bot._pumped = set()
    bot._pump_tasks = set()
    bot._pump_by_identity = {}
    bot._vad_state = {}
    bot._departed = {}
    bot._departed_sids = {}
    bot._closing = False
    bot._failing = False
    bot.room_name = "room-1"
    bot.transcriber = _RecordingTranscriber(per_stream, mixed_recording)
    bot.mixer = _NoopMixer()
    return bot


def _recording_start_pump(bot):
    started = []
    bot._start_pump = lambda track, identity: started.append((track.sid, identity))
    return started


# --- C7: publication.source gate ---------------------------------------------
def test_is_microphone_rejects_screenshare_audio():
    _patch_rtc()
    assert LiveKitBot._is_microphone(_Pub(_TRACK_SOURCE.SOURCE_MICROPHONE)) is True
    # SOURCE_UNKNOWN is admitted: a client that publishes without declaring a
    # source still means "microphone", and rejecting it would drop ALL its audio.
    assert LiveKitBot._is_microphone(_Pub(_TRACK_SOURCE.SOURCE_UNKNOWN)) is True
    assert LiveKitBot._is_microphone(_Pub(_TRACK_SOURCE.SOURCE_SCREENSHARE_AUDIO)) is False
    assert LiveKitBot._is_microphone(_Pub(_TRACK_SOURCE.SOURCE_SCREENSHARE)) is False
    assert LiveKitBot._is_microphone(_Pub(_TRACK_SOURCE.SOURCE_CAMERA)) is False
    # An SDK/publication with no `source` at all keeps the legacy kind-only gate.
    assert LiveKitBot._is_microphone(object()) is True
    print("ok: only MICROPHONE/UNKNOWN publications are pumped")


def test_track_subscribed_skips_screenshare_audio():
    bot = _make_bot()
    started = _recording_start_pump(bot)
    mic = _Track("TR_mic")
    share = _Track("TR_share")
    part = _P("alice", "Alice")
    bot._on_track_subscribed(mic, _Pub(_TRACK_SOURCE.SOURCE_MICROPHONE, mic), part)
    bot._on_track_subscribed(
        share, _Pub(_TRACK_SOURCE.SOURCE_SCREENSHARE_AUDIO, share), part
    )
    # A video track never reaches the audio pump either.
    cam = _Track("TR_cam", kind=_TRACK_KIND.KIND_VIDEO)
    bot._on_track_subscribed(cam, _Pub(_TRACK_SOURCE.SOURCE_CAMERA, cam), part)
    assert started == [("TR_mic", "alice")], started
    print("ok: a shared tab's audio track does not start a second pump")


def test_sweep_gates_on_publication_source():
    bot = _make_bot()
    started = _recording_start_pump(bot)
    mic = _Track("TR_mic")
    share = _Track("TR_share")
    part = _P(
        "bob",
        "Bob",
        publications=[
            _Pub(_TRACK_SOURCE.SOURCE_SCREENSHARE_AUDIO, share),
            _Pub(_TRACK_SOURCE.SOURCE_MICROPHONE, mic),
            # The usual case at connect time: the publication carries NO track yet.
            _Pub(_TRACK_SOURCE.SOURCE_MICROPHONE, None),
        ],
    )
    bot._sweep_participant(part)
    assert started == [("TR_mic", "bob")], started
    assert bot._participants["bob"] == "Bob"
    assert ("join", "bob", "Bob", 0) in bot.transcriber.calls
    print("ok: the post-connect sweep reads publication.source and skips trackless pubs")


# --- C7: one pump per identity ------------------------------------------------
def _drive(coro):
    return asyncio.run(coro)


def test_start_pump_dedupes_by_identity():
    bot = _make_bot()
    pumped = []

    async def fake_pump(track, identity):
        pumped.append((track.sid, identity))
        try:
            await asyncio.sleep(3600)
        except asyncio.CancelledError:
            pass

    bot._pump = fake_pump

    async def drive():
        bot._start_pump(_Track("TR_1"), "alice")
        # A SECOND audio track for the same identity (source-less client): the
        # sid differs, so only the identity guard can stop it.
        bot._start_pump(_Track("TR_2"), "alice")
        bot._start_pump(_Track("TR_3"), "bob")
        await asyncio.sleep(0)
        result = list(pumped)
        for task in list(bot._pump_tasks):
            task.cancel()
        await asyncio.gather(*bot._pump_tasks, return_exceptions=True)
        return result

    result = _drive(drive())
    assert result == [("TR_1", "alice"), ("TR_3", "bob")], result
    print("ok: a second track for one identity does not start a second pump")


# --- C10 / C11: the disconnect is authoritative -------------------------------
def test_tag_is_recycled_only_after_the_pump_is_dead():
    bot = _make_bot(per_stream=True)
    released = []

    async def fake_pump(track, identity):
        try:
            await asyncio.sleep(3600)
        except asyncio.CancelledError:
            released.append(identity)
            raise

    bot._pump = fake_pump

    async def drive():
        bot._participants["alice"] = "Alice"
        bot._tag_for("alice")  # tag 0
        bot._start_pump(_Track("TR_1"), "alice")
        await asyncio.sleep(0)
        bot._on_participant_disconnected(_P("alice"))
        # The pump is still winding down: the tag must NOT be back in the pool.
        assert bot._free_tags == [], bot._free_tags
        # Let the teardown task run.
        for _ in range(5):
            await asyncio.sleep(0)
        return list(bot._free_tags)

    free = _drive(drive())
    assert released == ["alice"], released
    assert free == [0], free
    print("ok: the tag returns to the pool only once the pump has stopped")


def test_no_tag_is_allocated_after_a_disconnect():
    bot = _make_bot(per_stream=True)
    bot._participants["alice"] = "Alice"
    assert bot._tag_for("alice") == 0
    bot._on_participant_disconnected(_P("alice"))
    assert ("leave", "alice", "Alice", 0) in bot.transcriber.calls
    # A pump frame landing after the leave must find NO tag (it is dropped),
    # instead of re-creating the sub-ASR the leave just tore down.
    assert bot._tag_for("alice") is None
    assert "alice" not in bot._tags
    print("ok: a late frame cannot re-allocate a tag for a departed participant")


def test_rejoin_lifts_the_departed_block():
    bot = _make_bot(per_stream=True)
    bot._participants["alice"] = "Alice"
    bot._tag_for("alice")
    bot._on_participant_disconnected(_P("alice"))
    assert bot._tag_for("alice") is None
    bot._register_participant(_P("alice", "Alice"))
    assert bot._tag_for("alice") == 0
    assert "alice" not in bot._departed
    print("ok: a re-joining identity is tagged again")


def test_disconnect_prunes_vad_state_and_remembers_the_speaker():
    bot = _make_bot(per_stream=True)
    bot._participants["alice"] = "Alice"
    bot._track_sids["alice"] = "TR_1"
    bot._pumped.add("TR_1")
    bot._vad_state["alice"] = 123.0
    bot._tag_for("alice")
    bot._on_participant_disconnected(_P("alice"))
    assert "alice" not in bot._vad_state, "the VAD hysteresis must be pruned too"
    assert bot._pumped == set()
    # Kept for late caption attribution (a final lands after the speaker leaves).
    assert bot._departed["alice"] == "Alice"
    assert bot._departed_sids["alice"] == "TR_1"
    print("ok: disconnect prunes _vad_state and remembers the departed speaker")


def test_departed_map_is_bounded():
    bot = _make_bot()
    for i in range(200):
        ident = f"id-{i}"
        bot._participants[ident] = ident
        bot._on_participant_disconnected(_P(ident))
    assert len(bot._departed) <= 64, len(bot._departed)
    assert "id-199" in bot._departed and "id-0" not in bot._departed
    print("ok: the departed map is FIFO-bounded")


# --- room "disconnected" ------------------------------------------------------
def test_room_disconnected_reports_through_the_owner_hook():
    bot = _make_bot()
    reasons = []

    async def on_failure(reason):
        reasons.append(reason)

    bot.transcriber.on_failure = on_failure

    async def drive():
        bot._on_room_disconnected("SIGNAL_CLOSE")
        for _ in range(3):
            await asyncio.sleep(0)

    _drive(drive())
    assert reasons == ["livekit-disconnected"], reasons
    print("ok: a terminated LiveKit session tears the bot down instead of zombieing")


def test_room_disconnected_is_ignored_while_disposing():
    bot = _make_bot()
    reasons = []
    bot.transcriber.on_failure = lambda reason: reasons.append(reason)
    bot._closing = True  # our own dispose() emits the same event

    async def drive():
        bot._on_room_disconnected("CLIENT_INITIATED")
        for _ in range(3):
            await asyncio.sleep(0)

    _drive(drive())
    assert reasons == [], reasons
    print("ok: our own dispose() does not re-enter the failure path")


_TESTS = [
    test_is_microphone_rejects_screenshare_audio,
    test_track_subscribed_skips_screenshare_audio,
    test_sweep_gates_on_publication_source,
    test_start_pump_dedupes_by_identity,
    test_tag_is_recycled_only_after_the_pump_is_dead,
    test_no_tag_is_allocated_after_a_disconnect,
    test_rejoin_lifts_the_departed_block,
    test_disconnect_prunes_vad_state_and_remembers_the_speaker,
    test_departed_map_is_bounded,
    test_room_disconnected_reports_through_the_owner_hook,
    test_room_disconnected_is_ignored_while_disposing,
]


def main():
    for t in _TESTS:
        t()
    print(f"\nALL {len(_TESTS)} TESTS PASSED")


if __name__ == "__main__":
    main()
