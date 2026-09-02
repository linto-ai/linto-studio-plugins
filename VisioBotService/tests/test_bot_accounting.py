"""What the BrokerClient must never get wrong about the bots it owns (K5 / #C1):

  - an orphan (a bot whose key was taken by a stopbot or a newer startbot while
    its start() was in flight) is disposed for REAL: the LiveKit room is left and
    the Transcriber WS is closed. A leak here is invisible — the bot is untracked,
    so nothing will ever dispose it — and it keeps an SFU subscription and an ASR
    session alive for the rest of the meeting;
  - `activeBots`, the number the Scheduler routes on, matches what is actually
    tracked at every step of those races;
  - a bot-error is published EXACTLY once per dead bot. The transcriber failure
    hook and the room-disconnected hook can both fire for the same bot (the SFU
    going away kills the room AND the audio the transcriber sees), and a second
    bot-error makes the Scheduler re-route a session it has already re-routed.

The bots are stand-ins whose dispose() IS LiveKitBot.dispose, so the room/WS
teardown under test is the real one; the heavy runtime deps are stubbed like in
the sibling suites and no MQTT/LiveKit connection is ever opened.

Run:  python3 VisioBotService/tests/test_bot_accounting.py
(or via pytest:  pytest VisioBotService/tests/test_bot_accounting.py)
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
    TrackSource=types.SimpleNamespace(SOURCE_UNKNOWN=0, SOURCE_MICROPHONE=2),
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
from bot.livekit_bot import LiveKitBot  # noqa: E402
from components.broker_client import BrokerClient  # noqa: E402


# --- fakes -------------------------------------------------------------------
class _FakeClient:
    def __init__(self):
        self.published = []

    def publish(self, topic, payload, qos=0, retain=False):
        try:
            payload = json.loads(payload)
        except Exception:  # noqa: BLE001
            pass
        self.published.append((topic, payload))

    def subscribe(self, topic, qos=0):
        pass

    def unsubscribe(self, topic):
        pass


class _FakeRoom:
    def __init__(self):
        self.disconnected = False

    async def disconnect(self):
        self.disconnected = True


class _FakeStream:
    def __init__(self):
        self.closed = False
        self.on_failure = None

    async def close(self):
        self.closed = True


class _FakeMixer:
    def __init__(self):
        self.running = True

    def stop(self):
        self.running = False


class _Bot:
    """A LiveKitBot stand-in that owns real-ish resources and disposes of them
    through the REAL LiveKitBot.dispose, so a leak in that path is caught here."""

    instances: list = []

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.publish_captions = True
        self.started = False
        self.gate: asyncio.Event | None = None
        self.room = _FakeRoom()
        self.transcriber = _FakeStream()
        self.mixer = _FakeMixer()
        self._pump_tasks = set()
        self._pump_by_identity = {}
        self._closing = False
        _Bot.instances.append(self)

    async def start(self):
        if self.gate is not None:
            await self.gate.wait()
        self.started = True
        return True

    dispose = LiveKitBot.dispose

    @property
    def disposed(self):
        return self.room.disconnected and self.transcriber.closed


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


def _startbot(bot_id=7, **extra):
    data = {
        "session": {
            "id": "S1",
            "meta": {"linto_native": {"livekitUrl": "wss://lk.example.org", "room": "r1"}},
        },
        "channel": {"id": 2},
        "websocketUrl": "ws://transcriber/ws",
        "botId": bot_id,
        "botType": "visio-native",
    }
    data.update(extra)
    return data


def _patch_bot():
    _Bot.instances = []
    old = broker_client_mod.LiveKitBot
    broker_client_mod.LiveKitBot = _Bot
    return old


def _active_bots(bc):
    """activeBots as the Scheduler reads it off the retained status."""
    return bc._status(True)["activeBots"]


def _bot_errors(bc):
    return [payload for topic, payload in bc.client.published if "bot-error" in topic]


# --- K5: an orphan releases its resources ------------------------------------
def test_an_orphaned_bot_leaves_the_room_and_closes_the_ws():
    old = _patch_bot()
    buf = io.StringIO()
    try:
        bc = _make_broker()

        async def drive():
            gate = asyncio.Event()
            original_init = _Bot.__init__

            def gated_init(self, **kwargs):
                original_init(self, **kwargs)
                self.gate = gate

            _Bot.__init__ = gated_init
            try:
                start = asyncio.create_task(bc.start_bot(_startbot()))
                for _ in range(10):
                    await asyncio.sleep(0)
                assert _active_bots(bc) == 0, "an in-flight start is not an active bot"
                await bc.stop_bot("S1", 2)  # the stop lands mid-start
                gate.set()
                await start
            finally:
                _Bot.__init__ = original_init

        with redirect_stdout(buf):
            asyncio.run(drive())

        orphan = _Bot.instances[0]
        assert orphan.started is True
        assert orphan.room.disconnected is True, "the orphan stayed in the LiveKit room"
        assert orphan.transcriber.closed is True, "the orphan kept its transcriber WS"
        assert orphan.mixer.running is False
        assert bc.bots == {}
        assert _active_bots(bc) == 0
    finally:
        broker_client_mod.LiveKitBot = old
    print("ok: a bot stopped mid-start leaves the room and closes its socket")


def test_active_bots_tracks_the_start_stop_race():
    old = _patch_bot()
    buf = io.StringIO()
    try:
        bc = _make_broker()

        async def drive():
            gate = asyncio.Event()
            original_init = _Bot.__init__
            first = {"seen": False}

            def gated_init(self, **kwargs):
                original_init(self, **kwargs)
                if not first["seen"]:
                    first["seen"] = True
                    self.gate = gate  # only the FIRST bot blocks

            _Bot.__init__ = gated_init
            try:
                a = asyncio.create_task(bc.start_bot(_startbot(bot_id=7)))
                for _ in range(10):
                    await asyncio.sleep(0)
                b = asyncio.create_task(bc.start_bot(_startbot(bot_id=8)))
                for _ in range(10):
                    await asyncio.sleep(0)
                gate.set()
                await asyncio.gather(a, b)
            finally:
                _Bot.__init__ = original_init

        with redirect_stdout(buf):
            asyncio.run(drive())

        superseded, winner = _Bot.instances
        assert superseded.disposed is True, "the superseded bot must release everything"
        assert winner.disposed is False
        # Two concurrent startbots on one key leave exactly ONE live bot, and the
        # number the Scheduler routes on says exactly that.
        assert bc.bots == {"S1_2": winner}
        assert _active_bots(bc) == 1
        assert bc._starting == {}
    finally:
        broker_client_mod.LiveKitBot = old
    print("ok: two concurrent startbots leave one bot and an accurate activeBots")


# --- #C1: one bot-error per dead bot ------------------------------------------
def test_a_dead_bot_reports_exactly_one_bot_error():
    old = _patch_bot()
    buf = io.StringIO()
    try:
        bc = _make_broker()

        async def drive():
            await bc.start_bot(_startbot(bot_id=11))
            bot = _Bot.instances[0]
            hook = bot.transcriber.on_failure
            assert callable(hook), "on_failure must be wired"
            # The transcriber gave up…
            await hook("transcriber-unreachable")
            # …and the room-disconnected path fires for the same bot right after
            # (one SFU outage kills both). The bot is already gone: reporting it
            # again would re-route a session the Scheduler has already re-routed.
            await hook("livekit-disconnected")
            return bot

        with redirect_stdout(buf):
            bot = asyncio.run(drive())

        assert _bot_errors(bc) == [
            {"botId": 11, "reason": "transcriber-unreachable"}
        ], _bot_errors(bc)
        assert bot.disposed is True
        assert bc.bots == {}
        assert _active_bots(bc) == 0
    finally:
        broker_client_mod.LiveKitBot = old
    print("ok: a dead bot publishes exactly one bot-error")


def test_a_failure_after_a_replacement_is_not_reported():
    """The failure hook of a REPLACED bot must stay silent: its key now belongs
    to the bot that took over, and a bot-error would kill a healthy session."""
    old = _patch_bot()
    buf = io.StringIO()
    try:
        bc = _make_broker()

        async def drive():
            await bc.start_bot(_startbot(bot_id=11))
            stale = _Bot.instances[0]
            await bc.start_bot(_startbot(bot_id=12))  # replaces it on the same key
            await stale.transcriber.on_failure("transcriber-unreachable")

        with redirect_stdout(buf):
            asyncio.run(drive())

        assert _bot_errors(bc) == [], _bot_errors(bc)
        assert bc.bots == {"S1_2": _Bot.instances[1]}
        assert _active_bots(bc) == 1
    finally:
        broker_client_mod.LiveKitBot = old
    print("ok: a superseded bot's late failure is not reported")


_TESTS = [
    test_an_orphaned_bot_leaves_the_room_and_closes_the_ws,
    test_active_bots_tracks_the_start_stop_race,
    test_a_dead_bot_reports_exactly_one_bot_error,
    test_a_failure_after_a_replacement_is_not_reported,
]


def main():
    for t in _TESTS:
        t()
    print(f"\nALL {len(_TESTS)} TESTS PASSED")


if __name__ == "__main__":
    main()
