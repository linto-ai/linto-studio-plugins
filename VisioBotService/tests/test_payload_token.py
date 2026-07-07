"""Standalone tests for the payload-token / fail-closed logic (Task C):

  - LiveKitBot._token() prefers a payload-supplied join_token and falls back to
    env-minting only when none was given (dev path).
  - BrokerClient.start_bot() resolves the capability descriptor generically
    (meta.native[<botType>] with meta.linto_native as the back-compat alias),
    passes the token through, and — under LIVEKIT_TOKEN_FROM_PAYLOAD — FAILS
    CLOSED (bot-error, no LiveKitBot built) when no token is present.
  - _publish_bot_error() surfaces a missing/invalid botId instead of a silent
    no-op.

Like test_tag_alloc.py, the heavy runtime deps (livekit / websockets / paho) are
stubbed in sys.modules so the pure-logic paths import without them, and objects
are built with __new__ so no Room / WS / MQTT connection is ever opened.

Run:  python3 VisioBotService/tests/test_payload_token.py
(or via pytest:  pytest VisioBotService/tests/test_payload_token.py)
"""
import asyncio
import json
import os
import sys
import types

# --- make the service importable and stub the not-installed runtime deps ------
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
             RoomOptions=object)
_lk.rtc = _rtc
_stub("livekit.api", AccessToken=object, VideoGrants=object)
_stub("websockets", connect=None)
# paho.mqtt.client — only needs to be importable; BrokerClient is built via
# __new__ and its .client is a hand-wired fake below.
_paho = _stub("paho")
_paho_mqtt = _stub("paho.mqtt")
_stub("paho.mqtt.client", Client=object,
      CallbackAPIVersion=types.SimpleNamespace(VERSION2=2))
_paho.mqtt = _paho_mqtt

import bot.livekit_bot as livekit_bot_mod  # noqa: E402
from bot.livekit_bot import LiveKitBot  # noqa: E402
import components.broker_client as broker_client_mod  # noqa: E402
from components.broker_client import BrokerClient  # noqa: E402


# --- fakes -------------------------------------------------------------------
class _FakeClient:
    def __init__(self):
        self.published = []  # list of (topic, payload_dict)

    def publish(self, topic, payload, qos=0, retain=False):
        try:
            payload = json.loads(payload)
        except Exception:
            pass
        self.published.append((topic, payload))


class _RecordingBot:
    """Stand-in for LiveKitBot: records ctor kwargs, start() succeeds."""

    instances = []

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        _RecordingBot.instances.append(self)

    async def start(self):
        return True

    async def dispose(self):
        pass


def _make_broker(token_from_payload):
    bc = BrokerClient.__new__(BrokerClient)
    bc.token_from_payload = token_from_payload
    bc.bots = {}
    bc.client = _FakeClient()
    bc.unique_id = "visio-bot-service-test"
    bc.capabilities = ["visio-native"]
    bc.pub = f"botservice/out/{bc.unique_id}"
    return bc


def _startbot_data(meta, bot_id=7, bot_type="visio-native"):
    return {
        "session": {"id": 1, "meta": meta},
        "channel": {"id": 2},
        "websocketUrl": "ws://transcriber/ws",
        "botId": bot_id,
        "botType": bot_type,
    }


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


# --- LiveKitBot._token -------------------------------------------------------
def test_token_prefers_payload_join_token():
    bot = LiveKitBot.__new__(LiveKitBot)
    bot.join_token = "PAYLOAD.JWT.TOKEN"
    bot.api_key = "devkey"
    bot.api_secret = "secret"
    bot.room_name = "room-1"
    assert bot._token() == "PAYLOAD.JWT.TOKEN"
    print("ok: _token() returns the payload join_token verbatim when present")


def test_token_env_mints_when_no_join_token(monkeypatch=None):
    # Fluent fake AccessToken so the env-mint fallback path is exercised without
    # the real livekit-api. Patch the name bound inside bot.livekit_bot.
    class _FakeAT:
        def __init__(self, key, secret):
            _FakeAT.built_with = (key, secret)

        def with_identity(self, *_a, **_k):
            return self

        def with_name(self, *_a, **_k):
            return self

        def with_grants(self, *_a, **_k):
            return self

        def to_jwt(self):
            return "ENV.MINTED.JWT"

    old_at = livekit_bot_mod.AccessToken
    old_vg = livekit_bot_mod.VideoGrants
    livekit_bot_mod.AccessToken = _FakeAT
    livekit_bot_mod.VideoGrants = lambda **_k: object()
    try:
        bot = LiveKitBot.__new__(LiveKitBot)
        bot.join_token = None
        bot.api_key = "mykey"
        bot.api_secret = "mysecret"
        bot.room_name = "room-1"
        assert bot._token() == "ENV.MINTED.JWT"
        assert _FakeAT.built_with == ("mykey", "mysecret")
    finally:
        livekit_bot_mod.AccessToken = old_at
        livekit_bot_mod.VideoGrants = old_vg
    print("ok: _token() env-mints from api_key/secret when join_token is absent")


# --- BrokerClient.start_bot descriptor resolution + token pass-through --------
def _patch_bot():
    _RecordingBot.instances = []
    old = broker_client_mod.LiveKitBot
    broker_client_mod.LiveKitBot = _RecordingBot
    return old


def test_startbot_uses_linto_native_alias_and_passes_token():
    old = _patch_bot()
    try:
        bc = _make_broker(token_from_payload=True)
        meta = {"linto_native": {"livekitUrl": "ws://lk", "room": "r1", "token": "T1"}}
        _run(bc.start_bot(_startbot_data(meta)))
        assert len(_RecordingBot.instances) == 1
        kw = _RecordingBot.instances[0].kwargs
        assert kw["livekit_url"] == "ws://lk"
        assert kw["room_name"] == "r1"
        assert kw["join_token"] == "T1"
        # started successfully -> no bot-error published
        assert not any("bot-error" in t for t, _ in bc.client.published)
    finally:
        broker_client_mod.LiveKitBot = old
    print("ok: start_bot resolves via linto_native alias and passes join_token")


def test_startbot_prefers_generic_native_map_by_bottype():
    old = _patch_bot()
    try:
        bc = _make_broker(token_from_payload=True)
        meta = {
            "native": {"visio-native": {"livekitUrl": "ws://gen", "room": "rg", "token": "TG"}},
            # alias present but STALE — the generic map for the botType must win.
            "linto_native": {"livekitUrl": "ws://old", "room": "ro", "token": "TO"},
        }
        _run(bc.start_bot(_startbot_data(meta, bot_type="visio-native")))
        kw = _RecordingBot.instances[0].kwargs
        assert kw["livekit_url"] == "ws://gen"
        assert kw["join_token"] == "TG"
    finally:
        broker_client_mod.LiveKitBot = old
    print("ok: start_bot prefers meta.native[<botType>] over the linto_native alias")


def test_startbot_fail_closed_without_token():
    old = _patch_bot()
    try:
        bc = _make_broker(token_from_payload=True)
        # descriptor present but NO token -> must fail closed, never build a bot.
        meta = {"linto_native": {"livekitUrl": "ws://lk", "room": "r1"}}
        _run(bc.start_bot(_startbot_data(meta, bot_id=42)))
        assert _RecordingBot.instances == []  # bot NEVER constructed
        errs = [p for t, p in bc.client.published if "bot-error" in t]
        assert errs, "expected a bot-error to be published on fail-closed"
        assert errs[0]["botId"] == 42
        assert bc.bots == {}
    finally:
        broker_client_mod.LiveKitBot = old
    print("ok: fail-closed (payload mode, no token) -> bot-error, no LiveKitBot built")


def test_startbot_dev_mode_env_mints_without_token():
    old = _patch_bot()
    try:
        bc = _make_broker(token_from_payload=False)
        # No token, but dev mode (flag off): the bot is built and will env-mint
        # (join_token=None passed through).
        meta = {"linto_native": {"livekitUrl": "ws://lk", "room": "r1"}}
        _run(bc.start_bot(_startbot_data(meta)))
        assert len(_RecordingBot.instances) == 1
        assert _RecordingBot.instances[0].kwargs["join_token"] is None
        assert not any("bot-error" in t for t, _ in bc.client.published)
    finally:
        broker_client_mod.LiveKitBot = old
    print("ok: dev mode (flag off, no token) still builds a bot with join_token=None")


# --- _publish_bot_error observability ----------------------------------------
def test_publish_bot_error_logs_missing_botid(capsys=None):
    bc = _make_broker(token_from_payload=True)
    import io
    import contextlib

    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        bc._publish_bot_error(None, "join-failed")
    out = buf.getvalue()
    assert "bot-error" in out and "None" in out
    # nothing published to the broker for an unaddressable error
    assert bc.client.published == []
    print("ok: _publish_bot_error logs (not silently drops) a missing/invalid botId")


_TESTS = [
    test_token_prefers_payload_join_token,
    test_token_env_mints_when_no_join_token,
    test_startbot_uses_linto_native_alias_and_passes_token,
    test_startbot_prefers_generic_native_map_by_bottype,
    test_startbot_fail_closed_without_token,
    test_startbot_dev_mode_env_mints_without_token,
    test_publish_bot_error_logs_missing_botid,
]


def main():
    for t in _TESTS:
        t()
    print(f"\nALL {len(_TESTS)} TESTS PASSED")


if __name__ == "__main__":
    main()
