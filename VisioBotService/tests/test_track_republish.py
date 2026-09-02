"""Track lifecycle edge cases in LiveKitBot:

  - a participant who unpublishes and republishes an audio track (mute/unmute on
    some clients, a device change) gets a NEW pump even if the old task has not
    drained its EOS yet — it used to be refused for the rest of the call;
  - `track_unsubscribed` stops the identity's pump and forgets its sid, so the
    same sid can be pumped again;
  - a finished pump forgets its sid (no unbounded `_pumped` growth over
    republish cycles) and a crashed pump says so on stdout instead of dying
    silently.

Run:  python3 VisioBotService/tests/test_track_republish.py
(or via pytest:  pytest VisioBotService/tests/test_track_republish.py)
"""
import asyncio
import io
import os
import sys
import types
from contextlib import redirect_stdout

_HERE = os.path.dirname(os.path.abspath(__file__))
_SVC = os.path.dirname(_HERE)  # VisioBotService/
if _SVC not in sys.path:
    sys.path.insert(0, _SVC)


def _stub(name, **attrs):
    mod = sys.modules.get(name) or types.ModuleType(name)
    for k, v in attrs.items():
        setattr(mod, k, v)
    sys.modules[name] = mod
    return mod


_TRACK_KIND = types.SimpleNamespace(KIND_AUDIO="audio")
_lk = _stub("livekit")
_rtc = _stub(
    "livekit.rtc",
    Room=object,
    AudioStream=object,
    TrackKind=_TRACK_KIND,
    RoomOptions=object,
    Transcription=object,
    TranscriptionSegment=object,
)
_lk.rtc = _rtc
_stub("livekit.api", AccessToken=object, VideoGrants=object)
_stub("websockets", connect=None)

import bot.livekit_bot as livekit_bot_mod  # noqa: E402
from bot.livekit_bot import LiveKitBot  # noqa: E402


# --- fakes -------------------------------------------------------------------
class _Track:
    def __init__(self, sid):
        self.sid = sid
        self.kind = _TRACK_KIND.KIND_AUDIO


class _P:
    def __init__(self, identity):
        self.identity = identity


class _EndingStream:
    """AudioStream stand-in that yields nothing and ends (track EOS)."""

    def __init__(self, track, sample_rate=16000, num_channels=1):
        self.closed = False

    def __aiter__(self):
        return self

    async def __anext__(self):
        raise StopAsyncIteration

    async def aclose(self):
        self.closed = True


class _CrashingStream(_EndingStream):
    async def __anext__(self):
        raise RuntimeError("decoder exploded")


def _make_bot():
    livekit_bot_mod.rtc.TrackKind = _TRACK_KIND
    bot = LiveKitBot.__new__(LiveKitBot)
    bot._tags = {}
    bot._free_tags = []
    bot._next_tag = 0
    bot._participants = {"u1": "Alice"}
    bot._track_sids = {}
    bot._left = {}
    bot._pumped = set()
    bot._pump_tasks = set()
    bot._pump_by_identity = {}
    bot._vad_state = {}
    bot._closing = False
    bot._failing = False
    bot._mixer_role = None
    bot.room_name = "room-1"
    return bot


def _run(coro):
    return asyncio.run(coro)


async def _never(*args):
    await asyncio.sleep(3600)


# --- republish: unsubscribe(old) then subscribe(new) before the old pump drained
def test_a_republished_track_is_pumped_before_the_old_pump_drained():
    async def scenario():
        bot = _make_bot()
        pumped = []

        async def fake_pump(track, identity):
            pumped.append((track.sid, identity))
            await asyncio.sleep(3600)

        bot._pump = fake_pump
        old_track = _Track("TR_old")
        bot._start_pump(old_track, "u1")
        old_task = bot._pump_by_identity["u1"]
        await asyncio.sleep(0)
        # The SDK unsubscribes the old track and delivers the republished one in
        # the same dispatch: the old task has NOT run its finally yet.
        bot._on_track_unsubscribed(old_track, None, _P("u1"))
        assert "u1" not in bot._pump_by_identity, "entry dropped synchronously"
        assert not old_task.done(), "the old task has not drained yet"
        bot._start_pump(_Track("TR_new"), "u1")
        new_task = bot._pump_by_identity["u1"]
        assert new_task is not old_task
        await asyncio.sleep(0)
        assert pumped == [("TR_old", "u1"), ("TR_new", "u1")]
        assert bot._track_sids["u1"] == "TR_new"
        assert "TR_new" in bot._pumped and "TR_old" not in bot._pumped
        new_task.cancel()
        await asyncio.gather(old_task, new_task, return_exceptions=True)
        assert old_task.cancelled()

    _run(scenario())
    print("ok: a republished track is pumped even before the old pump drained")


def test_a_second_live_track_for_the_same_identity_is_still_refused():
    async def scenario():
        bot = _make_bot()
        bot._pump = _never
        bot._start_pump(_Track("TR_mic"), "u1")
        task = bot._pump_by_identity["u1"]
        await asyncio.sleep(0)
        bot._start_pump(_Track("TR_share"), "u1")  # C7: first wins while alive
        assert bot._pump_by_identity["u1"] is task
        assert "TR_share" not in bot._pumped
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    _run(scenario())
    print("ok: C7 — a second concurrent track for one identity is refused")


def test_same_sid_is_still_deduplicated():
    async def scenario():
        bot = _make_bot()
        calls = []

        async def fake_pump(track, identity):
            calls.append(track.sid)
            await asyncio.sleep(3600)

        bot._pump = fake_pump
        t = _Track("TR_1")
        bot._start_pump(t, "u1")
        bot._start_pump(t, "u1")  # duplicate track_subscribed for the same sid
        await asyncio.sleep(0)
        assert calls == ["TR_1"]
        task = bot._pump_by_identity["u1"]
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    _run(scenario())
    print("ok: the same sid is pumped once")


def test_a_left_identity_is_never_pumped():
    async def scenario():
        bot = _make_bot()
        bot._left["u1"] = True
        bot._pump = _never
        bot._start_pump(_Track("TR_1"), "u1")
        assert bot._pump_by_identity == {} and bot._pumped == set()

    _run(scenario())
    print("ok: C11 — no pump for an identity that already left")


# --- track_unsubscribed --------------------------------------------------------
def test_track_unsubscribed_stops_the_pump_and_forgets_the_sid():
    async def scenario():
        bot = _make_bot()
        bot._pump = _never
        track = _Track("TR_1")
        bot._start_pump(track, "u1")
        task = bot._pump_by_identity["u1"]
        await asyncio.sleep(0)
        bot._on_track_unsubscribed(track, None, _P("u1"))
        assert "TR_1" not in bot._pumped
        await asyncio.gather(task, return_exceptions=True)
        assert task.cancelled()
        # …so the same sid can come back.
        bot._pump_by_identity.pop("u1", None)  # _never has no finally; the real _pump does
        bot._start_pump(track, "u1")
        assert "TR_1" in bot._pumped
        bot._pump_by_identity["u1"].cancel()
        await asyncio.gather(bot._pump_by_identity["u1"], return_exceptions=True)

    _run(scenario())
    print("ok: track_unsubscribed cancels the pump and frees the sid")


def test_track_unsubscribed_for_another_sid_leaves_the_live_pump_alone():
    async def scenario():
        bot = _make_bot()
        bot._pump = _never
        bot._start_pump(_Track("TR_live"), "u1")
        task = bot._pump_by_identity["u1"]
        await asyncio.sleep(0)
        bot._on_track_unsubscribed(_Track("TR_stale"), None, _P("u1"))
        await asyncio.sleep(0)
        assert not task.cancelled() and bot._pump_by_identity["u1"] is task
        assert "TR_live" in bot._pumped
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    _run(scenario())
    print("ok: a stale sid's unsubscribe does not touch the live pump")


# --- the real _pump: sid bookkeeping and error visibility ----------------------
def test_a_finished_pump_forgets_its_sid_and_its_identity_entry():
    async def scenario():
        bot = _make_bot()
        livekit_bot_mod.rtc.AudioStream = _EndingStream
        bot._start_pump(_Track("TR_1"), "u1")
        task = bot._pump_by_identity["u1"]
        await task
        assert "TR_1" not in bot._pumped, "a dead pump must not pin its sid"
        assert "u1" not in bot._pump_by_identity
        assert bot._pump_tasks == set()

    _run(scenario())
    print("ok: a finished pump cleans its sid/identity bookkeeping")


def test_a_crashing_pump_is_logged_not_silent():
    async def scenario():
        bot = _make_bot()
        livekit_bot_mod.rtc.AudioStream = _CrashingStream
        buf = io.StringIO()
        with redirect_stdout(buf):
            bot._start_pump(_Track("TR_1"), "u1")
            await bot._pump_by_identity["u1"]
        out = buf.getvalue()
        assert "audio pump for u1" in out and "decoder exploded" in out, out
        assert "TR_1" not in bot._pumped

    _run(scenario())
    print("ok: a pump crash is reported on stdout")


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print("ALL OK")
