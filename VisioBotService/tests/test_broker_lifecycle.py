"""Standalone tests for the BrokerClient lifecycle hardening and the service
bootstrap:

  K5   a 'stopbot' (or a second 'startbot') arriving DURING the slow start of a
       bot deterministically wins: the started bot is disposed instead of joining
       the room untracked, never disposed and never counted in activeBots.
  MQTT a broker reconnect re-issues the per-bot caption subscriptions (paho
       reconnects with a clean session, so they would otherwise be lost forever).
  SSRF the client-writable livekitUrl is validated before it is dialed, and a
       rejected URL fails closed with a bot-error and no LiveKitBot.
  SUBS an explicit enableDisplaySub=false in the payload opts that single bot out
       of in-room caption injection, whatever the replica-wide env default says.
  #C1  when the transcriber stream exhausts its reconnect retries, the bot-error
       the Scheduler subscribes to is published and the bot is torn down — INCLUDING
       inside the startup window, where on_failure is already armed but the bot is
       not yet in `bots`; a bot stopped on purpose still reports nothing.
  BOOT a crash inside BrokerClient.run() exits NON-ZERO so the orchestrator
       restarts the replica instead of seeing a clean stop.

Like the sibling tests the heavy runtime deps are stubbed in sys.modules, and
BrokerClient is built with __new__ so no MQTT/LiveKit connection is ever opened.

Run:  python3 VisioBotService/tests/test_broker_lifecycle.py
(or via pytest:  pytest VisioBotService/tests/test_broker_lifecycle.py)
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
_rtc = _stub("livekit.rtc", Room=object, AudioStream=object,
             TrackKind=types.SimpleNamespace(KIND_AUDIO="audio"),
             RoomOptions=object, Transcription=object, TranscriptionSegment=object)
_lk.rtc = _rtc
_stub("livekit.api", AccessToken=object, VideoGrants=object)
_stub("websockets", connect=None)
_paho = _stub("paho")
_paho_mqtt = _stub("paho.mqtt")
_paho_client = _stub("paho.mqtt.client", Client=object,
                     CallbackAPIVersion=types.SimpleNamespace(VERSION2=2))
_paho.mqtt = _paho_mqtt
_paho_mqtt.client = _paho_client

import components.broker_client as broker_client_mod  # noqa: E402
from components.broker_client import BrokerClient, validate_livekit_url  # noqa: E402


# --- fakes -------------------------------------------------------------------
class _FakeClient:
    def __init__(self):
        self.published = []      # (topic, payload)
        self.subscribed = []     # (topic, qos)
        self.unsubscribed = []

    def publish(self, topic, payload, qos=0, retain=False):
        try:
            payload = json.loads(payload)
        except Exception:  # noqa: BLE001
            pass
        self.published.append((topic, payload))

    def subscribe(self, topic, qos=0):
        self.subscribed.append((topic, qos))

    def unsubscribe(self, topic):
        self.unsubscribed.append(topic)


class _Bot:
    """LiveKitBot stand-in whose start() can be made to block."""

    instances = []

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.publish_captions = True
        self.disposed = False
        self.started = False
        self.gate: asyncio.Event | None = None
        self.transcriber = types.SimpleNamespace(on_failure=None)
        _Bot.instances.append(self)

    async def start(self):
        if self.gate is not None:
            await self.gate.wait()
        self.started = True
        return True

    async def dispose(self):
        self.disposed = True


def _make_broker(allowed_hosts=(), allow_private=False):
    bc = BrokerClient.__new__(BrokerClient)
    bc.token_from_payload = False
    bc.bots = {}
    bc._starting = {}
    bc._caption_subs = {}
    bc.livekit_allowed_hosts = frozenset(allowed_hosts)
    bc.livekit_allow_private = allow_private
    bc.client = _FakeClient()
    bc.unique_id = "visio-bot-service-test"
    bc.capabilities = ["visio-native"]
    bc.pub = f"botservice/out/{bc.unique_id}"
    bc.sub = f"botservice/in/{bc.unique_id}/#"
    return bc


def _startbot(meta=None, bot_id=7, **extra):
    data = {
        "session": {
            "id": "S1",
            "meta": meta
            if meta is not None
            else {"linto_native": {"livekitUrl": "wss://lk.example.org", "room": "r1"}},
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


def _run(coro):
    return asyncio.run(coro)


# --- K5: start/stop races ----------------------------------------------------
def test_stopbot_during_start_disposes_the_orphan():
    old = _patch_bot()
    buf = io.StringIO()
    try:
        bc = _make_broker()
        gate = None

        async def drive():
            nonlocal gate
            gate = asyncio.Event()
            original_init = _Bot.__init__

            def gated_init(self, **kwargs):
                original_init(self, **kwargs)
                self.gate = gate

            _Bot.__init__ = gated_init
            try:
                start = asyncio.create_task(bc.start_bot(_startbot()))
                # Let start_bot get as far as the (blocked) bot.start().
                for _ in range(10):
                    await asyncio.sleep(0)
                assert _Bot.instances, "the bot must be under construction"
                assert bc.bots == {}, "it is not tracked until it has started"
                # The stop lands mid-start.
                await bc.stop_bot("S1", 2)
                gate.set()
                await start
            finally:
                _Bot.__init__ = original_init

        with redirect_stdout(buf):
            _run(drive())

        bot = _Bot.instances[0]
        assert bot.started is True
        assert bot.disposed is True, "a bot stopped mid-start must be disposed"
        assert bc.bots == {}, "and must never end up tracked"
        assert bc._starting == {}
        assert "disposing orphan" in buf.getvalue()
    finally:
        broker_client_mod.LiveKitBot = old
    print("OK a stopbot during start wins and the orphan bot is disposed")


def test_second_startbot_does_not_leak_the_first():
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
            _run(drive())

        assert len(_Bot.instances) == 2
        assert _Bot.instances[0].disposed is True, "the superseded bot must be disposed"
        assert bc.bots == {"S1_2": _Bot.instances[1]}
    finally:
        broker_client_mod.LiveKitBot = old
    print("OK a second startbot on the same key does not leak the first bot")


# --- MQTT reconnect ----------------------------------------------------------
def test_on_connect_reissues_the_caption_subscriptions():
    old = _patch_bot()
    buf = io.StringIO()
    try:
        bc = _make_broker()
        with redirect_stdout(buf):
            _run(bc.start_bot(_startbot()))
        assert bc._caption_subs == {"S1_2": "transcriber/out/S1/2/#"}

        # paho reconnects with a CLEAN session: everything must be re-subscribed.
        bc.client = _FakeClient()
        with redirect_stdout(buf):
            bc._on_connect(bc.client, None, None, 0, None)
        topics = [t for t, _ in bc.client.subscribed]
        assert bc.sub in topics, topics  # the control topic is re-subscribed too
        assert "transcriber/out/S1/2/#" in topics, topics

        # ...and a stopped bot's topic is not resurrected.
        with redirect_stdout(buf):
            _run(bc.stop_bot("S1", 2))
        bc.client = _FakeClient()
        with redirect_stdout(buf):
            bc._on_connect(bc.client, None, None, 0, None)
        assert "transcriber/out/S1/2/#" not in [t for t, _ in bc.client.subscribed]
    finally:
        broker_client_mod.LiveKitBot = old
    print("OK a broker reconnect re-issues the live caption subscriptions")


# --- SSRF --------------------------------------------------------------------
def test_validate_livekit_url_accepts_and_rejects():
    assert validate_livekit_url("wss://lk.example.org") is None
    assert validate_livekit_url("ws://sfu.internal:7880/rtc") is None
    # Non-ws schemes never reach the SDK.
    assert validate_livekit_url("https://lk.example.org")
    assert validate_livekit_url("file:///etc/passwd")
    assert validate_livekit_url("")
    assert validate_livekit_url(None)
    assert validate_livekit_url("not a url")
    # Loopback / private / link-local / metadata targets.
    for bad in (
        "ws://localhost:7880",
        "ws://sfu.localhost:7880",
        "ws://127.0.0.1:7880",
        "ws://[::1]:7880",
        "ws://10.1.2.3:7880",
        "ws://192.168.0.5:7880",
        "ws://172.16.9.9:7880",
        "ws://169.254.169.254/latest/meta-data",
        "ws://0.0.0.0:7880",
        "ws://[::ffff:127.0.0.1]:7880",
    ):
        assert validate_livekit_url(bad), bad
        # ...but DEVELOPMENT re-admits them for the local stack.
        assert validate_livekit_url(bad, allow_private=True) is None, bad
    # An explicit accept-list is authoritative in BOTH directions.
    allowed = frozenset({"lk.example.org"})
    assert validate_livekit_url("wss://lk.example.org", allowed_hosts=allowed) is None
    assert validate_livekit_url("wss://evil.example.org", allowed_hosts=allowed)
    assert validate_livekit_url("ws://127.0.0.1", allowed_hosts=frozenset({"127.0.0.1"})) is None
    print("OK validate_livekit_url fails closed on non-ws/loopback/private targets")


def test_startbot_rejects_a_private_livekit_url():
    old = _patch_bot()
    buf = io.StringIO()
    try:
        bc = _make_broker()
        meta = {"linto_native": {"livekitUrl": "ws://169.254.169.254/", "room": "r1"}}
        with redirect_stdout(buf):
            _run(bc.start_bot(_startbot(meta=meta, bot_id=42)))
        assert _Bot.instances == [], "the bot must never be constructed"
        errors = [p for t, p in bc.client.published if "bot-error" in t]
        assert errors and errors[0]["botId"] == 42
        assert bc.bots == {} and bc._starting == {}
    finally:
        broker_client_mod.LiveKitBot = old
    print("OK a startbot with a private/link-local livekitUrl fails closed")


def test_startbot_accepts_a_private_livekit_url_in_development():
    old = _patch_bot()
    buf = io.StringIO()
    try:
        bc = _make_broker(allow_private=True)
        meta = {"linto_native": {"livekitUrl": "ws://localhost:7880", "room": "r1"}}
        with redirect_stdout(buf):
            _run(bc.start_bot(_startbot(meta=meta)))
        assert len(_Bot.instances) == 1
        assert bc.bots["S1_2"] is _Bot.instances[0]
    finally:
        broker_client_mod.LiveKitBot = old
    print("OK DEVELOPMENT re-admits the local loopback SFU")


# --- per-bot caption opt-out -------------------------------------------------
def test_enable_display_sub_false_opts_this_bot_out():
    old = _patch_bot()
    buf = io.StringIO()
    try:
        bc = _make_broker()
        with redirect_stdout(buf):
            _run(bc.start_bot(_startbot(enableDisplaySub=False)))
        bot = _Bot.instances[0]
        assert bot.publish_captions is False, "the per-bot opt-out must win"
        assert bc._caption_subs == {}, "and no caption topic is subscribed"
        assert bc.client.subscribed == []

        # An absent key keeps the replica-wide default (kill-switch semantics).
        bc2 = _make_broker()
        with redirect_stdout(buf):
            _run(bc2.start_bot(_startbot()))
        assert _Bot.instances[1].publish_captions is True
        assert bc2._caption_subs == {"S1_2": "transcriber/out/S1/2/#"}
    finally:
        broker_client_mod.LiveKitBot = old
    print("OK enableDisplaySub=false opts a single bot out of caption injection")


# --- transcriber failure -> bot-error ---------------------------------------
def test_transcriber_failure_publishes_bot_error_and_stops_the_bot():
    old = _patch_bot()
    buf = io.StringIO()
    try:
        bc = _make_broker()

        async def drive():
            await bc.start_bot(_startbot(bot_id=11))
            bot = _Bot.instances[0]
            assert callable(bot.transcriber.on_failure), "on_failure must be wired"
            await bot.transcriber.on_failure("transcriber-unreachable")
            return bot

        with redirect_stdout(buf):
            bot = _run(drive())

        errors = [p for t, p in bc.client.published if "bot-error" in t]
        assert errors == [{"botId": 11, "reason": "transcriber-unreachable"}], errors
        assert bot.disposed is True
        assert bc.bots == {}
    finally:
        broker_client_mod.LiveKitBot = old
    print("OK an exhausted transcriber link publishes bot-error and stops the bot")


async def _enter_startup_window(bc, data):
    """Drive start_bot until the bot is inside the STARTUP WINDOW — constructed,
    on_failure armed, start() parked on a gate, NOT yet registered in `bots` — and
    hand back (task, gate, bot)."""
    gate = asyncio.Event()
    original_init = _Bot.__init__

    def gated_init(self, **kwargs):
        original_init(self, **kwargs)
        self.gate = gate

    _Bot.__init__ = gated_init
    try:
        task = asyncio.create_task(bc.start_bot(data))
        for _ in range(10):
            await asyncio.sleep(0)
    finally:
        _Bot.__init__ = original_init
    assert _Bot.instances, "the bot must be under construction"
    bot = _Bot.instances[-1]
    assert bc.bots == {}, "the startup window: not registered until start() returns"
    assert callable(bot.transcriber.on_failure), "on_failure is armed BEFORE start()"
    return task, gate, bot


def test_a_transcriber_failure_during_start_is_reported_and_disposed():
    """on_failure is armed BEFORE `await bot.start()`, but the bot only lands in
    `bots` after it returns. The reconnect ladder can exhaust inside that window
    (~7 s by default) while start() is still joining the LiveKit room. The old
    `self.bots.get(key) is not bot` guard could not tell "not registered YET" from
    "replaced", so the failure was swallowed: no bot-error for the Scheduler to
    re-route on, no dispose, and start() went on to register a bot whose
    transcriber was dead for good — a room held and activeBots inflated for
    nothing."""
    old = _patch_bot()
    buf = io.StringIO()
    try:
        bc = _make_broker()

        async def drive():
            task, gate, bot = await _enter_startup_window(bc, _startbot(bot_id=13))
            await bot.transcriber.on_failure("transcriber-unreachable")
            gate.set()
            await task
            return bot

        with redirect_stdout(buf):
            bot = _run(drive())

        errors = [p for t, p in bc.client.published if "bot-error" in t]
        assert errors == [{"botId": 13, "reason": "transcriber-unreachable"}], errors
        assert bot.disposed is True, "the orphan bot must be disposed"
        assert bc.bots == {}, "a bot with a dead transcriber must never be registered"
        assert bc._starting == {}
    finally:
        broker_client_mod.LiveKitBot = old
    print("OK a transcriber failure during start is published and the bot disposed")


def test_a_transcriber_failure_after_a_stopbot_reports_nothing():
    """The mirror case the guard must keep: a stopbot already took the key, so the
    teardown is INTENTIONAL. Publishing a bot-error there would make the Scheduler
    re-route a session that was deliberately stopped."""
    old = _patch_bot()
    buf = io.StringIO()
    try:
        bc = _make_broker()

        async def drive():
            task, gate, bot = await _enter_startup_window(bc, _startbot(bot_id=14))
            await bc.stop_bot("S1", 2)  # the stop wins the key
            await bot.transcriber.on_failure("transcriber-unreachable")
            gate.set()
            await task
            return bot

        with redirect_stdout(buf):
            bot = _run(drive())

        assert [p for t, p in bc.client.published if "bot-error" in t] == []
        assert bot.disposed is True, "the orphan is still disposed by the start path"
        assert bc.bots == {}
    finally:
        broker_client_mod.LiveKitBot = old
    print("OK a stopped bot's transcriber failure reports no bot-error")


# --- bootstrap exit code ------------------------------------------------------
def _run_main(broker_cls):
    import visio_bot_service as svc

    saved_broker = svc.BrokerClient
    saved_components = os.environ.get("VISIOBOT_COMPONENTS")
    saved_dev = os.environ.get("DEVELOPMENT")
    svc.BrokerClient = broker_cls
    os.environ["VISIOBOT_COMPONENTS"] = "BrokerClient"
    os.environ["DEVELOPMENT"] = "true"
    try:
        try:
            asyncio.run(svc.main())
        except SystemExit as e:
            return e.code
        return 0
    finally:
        svc.BrokerClient = saved_broker
        if saved_components is None:
            os.environ.pop("VISIOBOT_COMPONENTS", None)
        else:
            os.environ["VISIOBOT_COMPONENTS"] = saved_components
        if saved_dev is None:
            os.environ.pop("DEVELOPMENT", None)
        else:
            os.environ["DEVELOPMENT"] = saved_dev


def test_component_crash_exits_non_zero():
    class _CrashingBroker:
        async def run(self):
            raise RuntimeError("mqtt client blew up")

        async def shutdown(self):
            pass

    buf = io.StringIO()
    with redirect_stdout(buf):
        code = _run_main(_CrashingBroker)
    assert code == 1, code
    assert "component crashed" in buf.getvalue()
    print("OK a crash inside BrokerClient.run() exits non-zero")


def test_clean_component_exit_stays_zero():
    class _QuietBroker:
        def __init__(self):
            self.stopped = False

        async def run(self):
            return

        async def shutdown(self):
            self.stopped = True

    buf = io.StringIO()
    with redirect_stdout(buf):
        code = _run_main(_QuietBroker)
    assert code == 0, code
    print("OK a component that returns cleanly still exits zero")


_TESTS = [
    test_stopbot_during_start_disposes_the_orphan,
    test_second_startbot_does_not_leak_the_first,
    test_on_connect_reissues_the_caption_subscriptions,
    test_validate_livekit_url_accepts_and_rejects,
    test_startbot_rejects_a_private_livekit_url,
    test_startbot_accepts_a_private_livekit_url_in_development,
    test_enable_display_sub_false_opts_this_bot_out,
    test_transcriber_failure_publishes_bot_error_and_stops_the_bot,
    test_a_transcriber_failure_during_start_is_reported_and_disposed,
    test_a_transcriber_failure_after_a_stopbot_reports_nothing,
    test_component_crash_exits_non_zero,
    test_clean_component_exit_stays_zero,
]


def main():
    for t in _TESTS:
        t()
    print(f"\nALL {len(_TESTS)} TESTS PASSED")


if __name__ == "__main__":
    main()
