"""Auto-leave parity with the web BotService (BotService/bot/index.js):

  - EMPTY_MEETING_TIMEOUT_SECONDS: once a participant HAS been seen, the bot
    leaves that long after the last one is gone, and the owner asks the
    Scheduler to END the session (scheduler/in/schedule/stopbot, endSession=true)
    exactly like a manual stop — otherwise a session started from Meet was never
    finalised and every clean end of meeting surfaced as a 'livekit-disconnected'
    bot-error;
  - JOIN_TIMEOUT_SECONDS: nobody was EVER seen after the join -> leave as a
    FAILURE ('join-timeout' bot-error + cleanup WITHOUT ending the session);
  - any join disarms both timers; dispose() cancels them; without an owner hook
    the bot disposes itself.

The heavy runtime deps are stubbed in sys.modules like in the sibling suites and
the bot is built with __new__, so no Room / WS / MQTT connection is ever opened.

Run:  python3 VisioBotService/tests/test_auto_leave.py
(or via pytest:  pytest VisioBotService/tests/test_auto_leave.py)
"""
import asyncio
import io
import json
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


_lk = _stub("livekit")
_rtc = _stub(
    "livekit.rtc",
    Room=object,
    AudioStream=object,
    TrackKind=types.SimpleNamespace(KIND_AUDIO="audio"),
    RoomOptions=object,
    Transcription=object,
    TranscriptionSegment=object,
)
_lk.rtc = _rtc
_stub("livekit.api", AccessToken=object, VideoGrants=object)
_stub("websockets", connect=None)
_paho = _stub("paho")
_paho_mqtt = _stub("paho.mqtt")
_paho_client = _stub(
    "paho.mqtt.client",
    Client=object,
    CallbackAPIVersion=types.SimpleNamespace(VERSION2=2),
)
_paho.mqtt = _paho_mqtt
_paho_mqtt.client = _paho_client

import components.broker_client as broker_client_mod  # noqa: E402
from bot.livekit_bot import (  # noqa: E402
    DEFAULT_EMPTY_MEETING_TIMEOUT_S,
    DEFAULT_JOIN_TIMEOUT_S,
    LiveKitBot,
    _env_timeout_seconds,
)
from components.broker_client import BrokerClient  # noqa: E402


# --- fakes -------------------------------------------------------------------
class _Transcriber:
    def __init__(self):
        self.calls = []
        self.closed = False
        self.on_failure = None

    def send_participant(self, action, pid, name, tag=None):
        self.calls.append((action, pid, name, tag))

    async def close(self):
        self.closed = True


class _Mixer:
    def __init__(self):
        self.running = True

    def remove_participant(self, ident):
        pass

    def update_name(self, ident, name):
        pass

    def stop(self):
        self.running = False


class _Room:
    def __init__(self):
        self.disconnected = False

    async def disconnect(self):
        self.disconnected = True


class _P:
    def __init__(self, identity, name=None):
        self.identity = identity
        self.name = name


def _make_bot(empty_s=0.05, join_s=0.05):
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
    bot.transcriber = _Transcriber()
    bot.mixer = _Mixer()
    bot.room = _Room()
    bot._has_seen_participant = False
    bot._empty_meeting_handle = None
    bot._join_watchdog_handle = None
    bot._empty_meeting_timeout_s = empty_s
    bot._join_timeout_s = join_s
    bot.on_meeting_empty = None
    bot.on_join_timeout = None
    return bot


def _run(coro):
    return asyncio.run(coro)


# --- env rule ----------------------------------------------------------------
def test_env_timeout_rule_matches_the_web_bot():
    for name in ("EMPTY_MEETING_TIMEOUT_SECONDS", "JOIN_TIMEOUT_SECONDS"):
        os.environ.pop(name, None)
    assert _env_timeout_seconds("EMPTY_MEETING_TIMEOUT_SECONDS", DEFAULT_EMPTY_MEETING_TIMEOUT_S) == 60.0
    assert _env_timeout_seconds("JOIN_TIMEOUT_SECONDS", DEFAULT_JOIN_TIMEOUT_S) == 120.0
    os.environ["EMPTY_MEETING_TIMEOUT_SECONDS"] = "7"
    assert _env_timeout_seconds("EMPTY_MEETING_TIMEOUT_SECONDS", 60) == 7.0
    # 0 / negative / garbage -> default, exactly like envTimeoutMs.
    for bad in ("0", "-3", "abc", ""):
        os.environ["EMPTY_MEETING_TIMEOUT_SECONDS"] = bad
        assert _env_timeout_seconds("EMPTY_MEETING_TIMEOUT_SECONDS", 60) == 60.0
    os.environ.pop("EMPTY_MEETING_TIMEOUT_SECONDS", None)
    print("ok: timeout env rule (positive int else default)")


# --- empty-meeting timer -----------------------------------------------------
def test_empty_meeting_timer_arms_on_last_leave_and_calls_the_hook():
    async def scenario():
        bot = _make_bot()
        fired = []
        bot.on_meeting_empty = lambda: fired.append("empty")
        bot._register_participant(_P("u1", "Alice"))
        assert bot._has_seen_participant is True
        bot._on_participant_disconnected(_P("u1", "Alice"))
        assert bot._empty_meeting_handle is not None, "timer must arm on the last leave"
        await asyncio.sleep(0.15)
        assert fired == ["empty"]
        assert bot._failing is True, "the leave latches _failing so the room disconnect is a no-op"
        assert bot._empty_meeting_handle is None

    _run(scenario())
    print("ok: last participant leaves -> timer -> on_meeting_empty")


def test_a_join_disarms_the_empty_meeting_timer():
    async def scenario():
        bot = _make_bot()
        fired = []
        bot.on_meeting_empty = lambda: fired.append("empty")
        bot._register_participant(_P("u1"))
        bot._on_participant_disconnected(_P("u1"))
        assert bot._empty_meeting_handle is not None
        bot._register_participant(_P("u2"))  # someone comes back
        assert bot._empty_meeting_handle is None, "a join must cancel the timer"
        await asyncio.sleep(0.15)
        assert fired == []
        assert bot._failing is False

    _run(scenario())
    print("ok: a (re)join cancels the empty-meeting timer")


def test_no_empty_meeting_timer_before_anyone_was_seen():
    async def scenario():
        bot = _make_bot()
        # A stray disconnect for an identity we never registered: the room was
        # never populated from our point of view, that is the watchdog's job.
        bot._on_participant_disconnected(_P("ghost"))
        assert bot._empty_meeting_handle is None

    _run(scenario())
    print("ok: no empty-meeting timer before the first participant")


def test_timer_is_armed_only_once_and_not_while_populated():
    async def scenario():
        bot = _make_bot(empty_s=10)
        bot._register_participant(_P("u1"))
        bot._register_participant(_P("u2"))
        bot._on_participant_disconnected(_P("u1"))
        assert bot._empty_meeting_handle is None, "u2 is still here"
        bot._on_participant_disconnected(_P("u2"))
        first = bot._empty_meeting_handle
        assert first is not None
        bot._check_empty_meeting()
        assert bot._empty_meeting_handle is first, "idempotent: no second timer"
        bot._cancel_timer("_empty_meeting_handle")

    _run(scenario())
    print("ok: timer only when the room is really empty, armed once")


# --- join watchdog -----------------------------------------------------------
def test_join_watchdog_fires_when_nobody_is_ever_seen():
    async def scenario():
        bot = _make_bot()
        fired = []
        bot.on_join_timeout = lambda: fired.append("join-timeout")
        bot._arm_join_watchdog()
        assert bot._join_watchdog_handle is not None
        await asyncio.sleep(0.15)
        assert fired == ["join-timeout"]
        assert bot._failing is True

    _run(scenario())
    print("ok: join watchdog -> on_join_timeout")


def test_first_participant_cancels_the_join_watchdog():
    async def scenario():
        bot = _make_bot()
        fired = []
        bot.on_join_timeout = lambda: fired.append("join-timeout")
        bot._arm_join_watchdog()
        bot._register_participant(_P("u1"))
        assert bot._join_watchdog_handle is None
        await asyncio.sleep(0.15)
        assert fired == []
        # and it never re-arms once somebody was seen
        bot._arm_join_watchdog()
        assert bot._join_watchdog_handle is None

    _run(scenario())
    print("ok: the first participant disarms the join watchdog for good")


# --- lifecycle ---------------------------------------------------------------
def test_dispose_cancels_both_timers():
    async def scenario():
        bot = _make_bot()
        fired = []
        bot.on_meeting_empty = lambda: fired.append("empty")
        bot.on_join_timeout = lambda: fired.append("join-timeout")
        bot._arm_join_watchdog()
        bot._register_participant(_P("u1"))
        bot._on_participant_disconnected(_P("u1"))
        assert bot._empty_meeting_handle is not None
        await bot.dispose()
        assert bot._empty_meeting_handle is None
        assert bot._join_watchdog_handle is None
        await asyncio.sleep(0.15)
        assert fired == []

    _run(scenario())
    print("ok: dispose() cancels the auto-leave timers")


def test_without_an_owner_hook_the_bot_disposes_itself():
    async def scenario():
        bot = _make_bot()
        bot._register_participant(_P("u1"))
        bot._on_participant_disconnected(_P("u1"))
        await asyncio.sleep(0.15)
        assert bot.room.disconnected is True
        assert bot.transcriber.closed is True
        assert bot._closing is True

    _run(scenario())
    print("ok: no hook -> self-dispose")


def test_a_raising_hook_still_disposes_the_bot():
    async def scenario():
        bot = _make_bot()

        def boom():
            raise RuntimeError("owner exploded")

        bot.on_meeting_empty = boom
        bot._register_participant(_P("u1"))
        bot._on_participant_disconnected(_P("u1"))
        buf = io.StringIO()
        with redirect_stdout(buf):
            await asyncio.sleep(0.15)
        assert bot.room.disconnected is True
        assert "owner exploded" in buf.getvalue()

    _run(scenario())
    print("ok: a raising hook falls back to self-dispose")


# --- BrokerClient side -------------------------------------------------------
class _FakeClient:
    def __init__(self):
        self.published = []

    def publish(self, topic, payload, qos=0, retain=False):
        try:
            payload = json.loads(payload)
        except Exception:  # noqa: BLE001
            pass
        self.published.append((topic, payload, qos))

    def subscribe(self, topic, qos=0):
        pass

    def unsubscribe(self, topic):
        pass


class _OwnedBot:
    instances = []

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.publish_captions = True
        self.disposed = False
        self.transcriber = types.SimpleNamespace(on_failure=None)
        self.on_meeting_empty = None
        self.on_join_timeout = None
        _OwnedBot.instances.append(self)

    async def start(self):
        return True

    async def dispose(self):
        self.disposed = True


def _make_broker():
    bc = BrokerClient.__new__(BrokerClient)
    bc.token_from_payload = False
    bc.bots = {}
    bc._starting = {}
    bc._caption_subs = {}
    bc.livekit_allowed_hosts = frozenset()
    bc.livekit_allow_private = False
    bc.client = _FakeClient()
    bc.unique_id = "visio-bot-service-test"
    bc.capabilities = ["visio-native"]
    bc.pub = f"botservice/out/{bc.unique_id}"
    bc.sub = f"botservice/in/{bc.unique_id}/#"
    return bc


def _startbot(bot_id=7):
    return {
        "session": {
            "id": "S1",
            "meta": {"linto_native": {"livekitUrl": "wss://lk.example.org", "room": "r1"}},
        },
        "channel": {"id": 2},
        "websocketUrl": "ws://transcriber/ws/S1,0",
        "botId": bot_id,
        "botType": "visio-native",
    }


def _scheduler_stops(bc):
    return [p for t, p, q in bc.client.published if t == "scheduler/in/schedule/stopbot"]


def _bot_errors(bc):
    return [p for t, p, q in bc.client.published if "bot-error" in t]


def test_meeting_empty_ends_the_session_and_stops_the_bot():
    async def scenario():
        old = broker_client_mod.LiveKitBot
        broker_client_mod.LiveKitBot = _OwnedBot
        _OwnedBot.instances = []
        try:
            bc = _make_broker()
            with redirect_stdout(io.StringIO()):
                await bc.start_bot(_startbot(bot_id=7))
                bot = bc.bots["S1_2"]
                assert callable(bot.on_meeting_empty) and callable(bot.on_join_timeout)
                await bot.on_meeting_empty()
            assert _scheduler_stops(bc) == [{"botId": 7, "endSession": True}]
            assert _bot_errors(bc) == [], "an empty meeting is a clean end, not an error"
            assert "S1_2" not in bc.bots
            assert bot.disposed is True
            # QoS 1, like the web bot's _requestSchedulerCleanup
            assert [q for t, p, q in bc.client.published if t == "scheduler/in/schedule/stopbot"] == [1]
        finally:
            broker_client_mod.LiveKitBot = old

    _run(scenario())
    print("ok: meeting-empty -> scheduler stopbot endSession=true + stop_bot")


def test_join_timeout_is_a_bot_error_and_does_not_end_the_session():
    async def scenario():
        old = broker_client_mod.LiveKitBot
        broker_client_mod.LiveKitBot = _OwnedBot
        _OwnedBot.instances = []
        try:
            bc = _make_broker()
            with redirect_stdout(io.StringIO()):
                await bc.start_bot(_startbot(bot_id=9))
                bot = bc.bots["S1_2"]
                await bot.on_join_timeout()
            assert _scheduler_stops(bc) == [{"botId": 9, "endSession": False}]
            assert _bot_errors(bc) == [{"botId": 9, "reason": "join-timeout"}]
            assert "S1_2" not in bc.bots
            assert bot.disposed is True
        finally:
            broker_client_mod.LiveKitBot = old

    _run(scenario())
    print("ok: join-timeout -> bot-error + cleanup without endSession")


def test_a_replaced_bot_cannot_end_the_successors_session():
    async def scenario():
        bc = _make_broker()
        stale = _OwnedBot()
        live = _OwnedBot()
        bc.bots["S1_2"] = live
        with redirect_stdout(io.StringIO()):
            await bc._on_meeting_empty(stale, "S1_2", "S1", 2, 7)
            await bc._on_join_timeout(stale, "S1_2", "S1", 2, 7)
        assert bc.client.published == []
        assert bc.bots["S1_2"] is live and live.disposed is False

    _run(scenario())
    print("ok: a stale bot's leave is ignored (ownership guard)")


def test_scheduler_cleanup_needs_a_valid_bot_id():
    bc = _make_broker()
    with redirect_stdout(io.StringIO()):
        bc._request_scheduler_cleanup(None, end_session=True)
        bc._request_scheduler_cleanup(0)
        bc._request_scheduler_cleanup("7")
    assert bc.client.published == []
    print("ok: no scheduler cleanup without a positive int botId")


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print("ALL OK")
