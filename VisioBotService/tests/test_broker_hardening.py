"""BrokerClient hardening:

  MQTT  nothing may escape `_on_message`: it runs on paho's network thread and
        paho 2.x re-raises callback exceptions out of its loop, which then EXITS
        — the replica keeps heartbeating into a dead client with a green
        healthcheck. `null`, a list, a string are all valid JSON that used to
        raise on `data.get(...)`.
  K5b   the key reservation is taken BEFORE the first await of start_bot, so a
        stopbot landing while the PREDECESSOR is still disposing is honoured:
        no replacement is started (it would have had no row and no owner left
        to ever stop it).
  RSS   the status reports the CURRENT resident set, not the peak.

Run:  python3 VisioBotService/tests/test_broker_hardening.py
(or via pytest:  pytest VisioBotService/tests/test_broker_hardening.py)
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


class _Msg:
    def __init__(self, topic, payload):
        self.topic = topic
        self.payload = payload if isinstance(payload, bytes) else payload.encode("utf-8")


class _Bot:
    instances = []

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.publish_captions = True
        self.started = False
        self.disposed = False
        self.dispose_gate: asyncio.Event | None = None
        self.transcriber = types.SimpleNamespace(on_failure=None)
        _Bot.instances.append(self)

    async def start(self):
        self.started = True
        return True

    async def dispose(self):
        if self.dispose_gate is not None:
            await self.dispose_gate.wait()
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
    bc.loop = None
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


def _run(coro):
    return asyncio.run(coro)


# --- MQTT: malformed payloads never escape the paho callback ------------------
def test_non_object_json_payloads_are_dropped_not_raised():
    async def scenario():
        bc = _make_broker()
        bc.loop = asyncio.get_running_loop()
        sub = f"botservice/in/{bc.unique_id}"
        cases = [
            (f"{sub}/stopbot", "null"),
            (f"{sub}/stopbot", "[]"),
            (f"{sub}/stopbot", '"x"'),
            (f"{sub}/stopbot", "42"),
            (f"{sub}/startbot", "null"),
            (f"{sub}/startbot", '["session"]'),
            ("transcriber/out/S1/2/final", "null"),
            ("transcriber/out/S1/2/final", "[1,2]"),
            (f"{sub}/stopbot", "{not json"),
            (f"{sub}/stopbot", b"\xff\xfe"),
        ]
        buf = io.StringIO()
        with redirect_stdout(buf):
            for topic, payload in cases:
                bc._on_message(None, None, _Msg(topic, payload))  # must not raise
            await asyncio.sleep(0)
            await asyncio.sleep(0)
        out = buf.getvalue()
        assert out.count("malformed MQTT message") == len(cases), out
        assert bc.bots == {} and bc._starting == {}

    _run(scenario())
    print("ok: null / list / string / number / invalid JSON payloads are logged and dropped")


def test_any_exception_inside_dispatch_is_contained():
    bc = _make_broker()

    def boom(msg):
        raise RuntimeError("dispatch exploded")

    bc._dispatch_message = boom
    buf = io.StringIO()
    with redirect_stdout(buf):
        bc._on_message(None, None, _Msg("botservice/in/x/stopbot", "{}"))  # must not raise
    assert "dispatch exploded" in buf.getvalue()
    # Even a message object with no usable topic is survivable.
    with redirect_stdout(io.StringIO()):
        bc._dispatch_message = BrokerClient._dispatch_message.__get__(bc)
        bc._on_message(None, None, types.SimpleNamespace(topic=None, payload=b"{}"))
    print("ok: the paho callback never propagates an exception")


def test_a_well_formed_stopbot_is_still_dispatched():
    async def scenario():
        bc = _make_broker()
        bc.loop = asyncio.get_running_loop()
        stopped = []

        async def fake_stop(session_id, channel_id):
            stopped.append((session_id, channel_id))

        bc.stop_bot = fake_stop
        bc._on_message(
            None, None, _Msg(f"botservice/in/{bc.unique_id}/stopbot", '{"sessionId":"S1","channelId":2}')
        )
        for _ in range(3):
            await asyncio.sleep(0)
        assert stopped == [("S1", 2)]

    _run(scenario())
    print("ok: the happy path is unchanged")


# --- K5b: reservation before the predecessor's dispose -------------------------
def test_stop_during_predecessor_dispose_prevents_the_replacement():
    async def scenario():
        old = broker_client_mod.LiveKitBot
        broker_client_mod.LiveKitBot = _Bot
        _Bot.instances = []
        try:
            bc = _make_broker()
            predecessor = _Bot()
            predecessor.dispose_gate = asyncio.Event()  # dispose blocks until released
            bc.bots["S1_2"] = predecessor
            with redirect_stdout(io.StringIO()):
                start = asyncio.create_task(bc.start_bot(_startbot(bot_id=8)))
                await asyncio.sleep(0)  # start_bot is now parked on predecessor.dispose()
                assert "S1_2" in bc._starting, "reservation must exist BEFORE the first await"
                assert "S1_2" not in bc.bots, "predecessor already popped for disposal"
                # Studio deletes the bot while the predecessor is still disposing.
                await bc.stop_bot("S1", 2)
                assert "S1_2" not in bc._starting
                predecessor.dispose_gate.set()
                await start
            assert predecessor.disposed is True
            assert "S1_2" not in bc.bots, "no orphan replacement may be registered"
            assert len(_Bot.instances) == 1, "no replacement bot was even built"
        finally:
            broker_client_mod.LiveKitBot = old

    _run(scenario())
    print("ok: a stop landing during the predecessor's dispose wins")


def test_replacing_a_predecessor_still_starts_the_successor():
    async def scenario():
        old = broker_client_mod.LiveKitBot
        broker_client_mod.LiveKitBot = _Bot
        _Bot.instances = []
        try:
            bc = _make_broker()
            predecessor = _Bot()
            bc.bots["S1_2"] = predecessor
            with redirect_stdout(io.StringIO()):
                await bc.start_bot(_startbot(bot_id=8))
            assert predecessor.disposed is True
            successor = bc.bots["S1_2"]
            assert successor is not predecessor and successor.started is True
            assert bc._starting == {}, "reservation released once registered"
        finally:
            broker_client_mod.LiveKitBot = old

    _run(scenario())
    print("ok: the ordinary replace path still registers the successor")


def test_a_newer_startbot_during_predecessor_dispose_wins():
    async def scenario():
        old = broker_client_mod.LiveKitBot
        broker_client_mod.LiveKitBot = _Bot
        _Bot.instances = []
        try:
            bc = _make_broker()
            predecessor = _Bot()
            predecessor.dispose_gate = asyncio.Event()
            bc.bots["S1_2"] = predecessor
            with redirect_stdout(io.StringIO()):
                first = asyncio.create_task(bc.start_bot(_startbot(bot_id=8)))
                await asyncio.sleep(0)
                second = asyncio.create_task(bc.start_bot(_startbot(bot_id=9)))
                await asyncio.sleep(0)
                predecessor.dispose_gate.set()
                await asyncio.gather(first, second)
            live = bc.bots["S1_2"]
            assert live.kwargs["bot_id"] == 9, "the newest startbot owns the key"
            built = [b for b in _Bot.instances if b is not predecessor]
            assert len(built) == 1, "the superseded start never built a bot"
        finally:
            broker_client_mod.LiveKitBot = old

    _run(scenario())
    print("ok: a newer startbot during the dispose supersedes the older one")


# --- RSS ---------------------------------------------------------------------
def test_rss_is_the_current_resident_set():
    bc = _make_broker()
    rss = bc._rss_bytes()
    assert isinstance(rss, int) and rss > 0
    if os.path.exists("/proc/self/statm"):
        with open("/proc/self/statm", "r", encoding="ascii") as f:
            pages = int(f.read().split()[1])
        assert abs(rss - pages * os.sysconf("SC_PAGE_SIZE")) < 64 * 1024 * 1024
    status = bc._status(True)
    assert status["rss"] == status["heapUsed"] > 0
    print("ok: rss is read from /proc/self/statm (current, not peak)")


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print("ALL OK")
