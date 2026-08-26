"""Standalone tests for the caption -> LiveKit transcription-segment mapping
(bot/captions.py) and the BrokerClient routing of Transcriber caption topics.

Pure logic: no livekit / paho import needed for captions.py; the BrokerClient
routing test stubs the runtime deps like the sibling tests do.

Run:  python3 VisioBotService/tests/test_captions.py
(or via pytest:  pytest VisioBotService/tests/test_captions.py)
"""
import asyncio
import json
import os
import sys
import types

_HERE = os.path.dirname(os.path.abspath(__file__))
_SVC = os.path.dirname(_HERE)  # VisioBotService/
if _SVC not in sys.path:
    sys.path.insert(0, _SVC)

from bot.captions import caption_to_segment, resolve_speaker, topic_kind  # noqa: E402


def test_topic_kind():
    assert topic_kind("transcriber/out/S1/7/partial") == ("S1", "7", "partial", False)
    assert topic_kind("transcriber/out/S1/7/final") == ("S1", "7", "final", False)
    assert topic_kind("transcriber/out/S1/7/final/translations") == ("S1", "7", "final", True)
    assert topic_kind("transcriber/out/S1/7/partial/translations") == (
        "S1", "7", "partial", True,
    )
    assert topic_kind("botservice/in/x/startbot") is None
    assert topic_kind("transcriber/out/S1/7/other") is None
    assert topic_kind("transcriber/out/S1/7/final/extra") is None
    assert topic_kind("transcriber/out/S1") is None


def test_caption_to_segment_original_partial_and_final_share_id():
    partial = {"segmentId": 12, "text": "bonjour à", "start": 1.5, "end": 2.25, "lang": "fr"}
    final = {"segmentId": 12, "text": "Bonjour à tous.", "start": 1.5, "end": 3.0, "lang": "fr"}
    assert caption_to_segment(partial, "partial", False) == (
        "linto:12", "bonjour à", 1500, 2250, "fr", False,
    )
    assert caption_to_segment(final, "final", False) == (
        "linto:12", "Bonjour à tous.", 1500, 3000, "fr", True,
    )


def test_caption_to_segment_translation_is_namespaced_by_target_lang():
    tr = {
        "segmentId": 12, "text": "Hello everyone.", "start": 1.5, "end": 3.0,
        "sourceLang": "fr", "targetLang": "en", "final": True, "mode": "discrete",
    }
    assert caption_to_segment(tr, "final", True) == (
        "linto:12:en", "Hello everyone.", 1500, 3000, "en", True,
    )
    # The payload's own `final` flag wins over the topic kind for translations.
    tr_partial = dict(tr, final=False)
    assert caption_to_segment(tr_partial, "final", True)[5] is False
    # No target language -> nothing to publish.
    assert caption_to_segment({"segmentId": 1, "text": "x"}, "final", True) is None


def test_caption_to_segment_rejects_empty_or_malformed():
    assert caption_to_segment({"segmentId": 1, "text": "   "}, "final", False) is None
    assert caption_to_segment({"text": "no id"}, "final", False) is None
    assert caption_to_segment("nope", "final", False) is None
    # Bad timestamps degrade to 0 / clamp end >= start instead of raising.
    seg = caption_to_segment({"segmentId": 3, "text": "t", "start": "x", "end": None}, "partial", False)
    assert seg == ("linto:3", "t", 0, 0, "", False)
    seg = caption_to_segment({"segmentId": 3, "text": "t", "start": 5, "end": 2}, "partial", False)
    assert seg[2] == 5000 and seg[3] == 5000


def test_resolve_speaker_prefers_participant_id_then_name_then_bot():
    participants = {"id-alice": "Alice", "id-bob": "Bob"}
    assert resolve_speaker({"participantId": "id-bob", "locutor": "Alice"}, participants, "bot") == "id-bob"
    assert resolve_speaker({"locutor": "Alice"}, participants, "bot") == "id-alice"
    # Locutor may already be an identity (no display name case).
    assert resolve_speaker({"locutor": "id-bob"}, participants, "bot") == "id-bob"
    assert resolve_speaker({"locutor": "Guest-3"}, participants, "bot") == "bot"
    assert resolve_speaker({}, participants, "bot") == "bot"


# ---- BrokerClient routing (stubbed runtime) ---------------------------------
def _stub(name, **attrs):
    mod = types.ModuleType(name)
    for k, v in attrs.items():
        setattr(mod, k, v)
    sys.modules[name] = mod
    return mod


def _load_broker_client():
    for name in list(sys.modules):
        if name in ("components.broker_client", "bot.livekit_bot"):
            del sys.modules[name]
    _stub("livekit", rtc=types.SimpleNamespace(Room=object, AudioStream=object,
                                               TrackKind=types.SimpleNamespace(KIND_AUDIO=1),
                                               RoomOptions=object, Transcription=object,
                                               TranscriptionSegment=object))
    _stub("livekit.rtc")
    _stub("livekit.api", AccessToken=object, VideoGrants=object)
    _stub("websockets", connect=None)
    paho = _stub("paho")
    mqtt = _stub("paho.mqtt")
    client_mod = _stub("paho.mqtt.client", Client=object,
                       CallbackAPIVersion=types.SimpleNamespace(VERSION2=2))
    paho.mqtt = mqtt
    mqtt.client = client_mod
    from components.broker_client import BrokerClient  # noqa: WPS433
    return BrokerClient


def test_broker_routes_caption_topics_to_the_matching_bot():
    BrokerClient = _load_broker_client()
    bc = BrokerClient.__new__(BrokerClient)
    bc.bots = {}
    bc.loop = asyncio.new_event_loop()
    bc.client = None

    calls = []

    class FakeBot:
        publish_captions = True

        async def publish_caption(self, payload, kind, is_translation):
            calls.append((payload, kind, is_translation))

    bc.bots["S1_7"] = FakeBot()

    def msg(topic, payload):
        return types.SimpleNamespace(topic=topic, payload=json.dumps(payload).encode())

    bc._on_message(None, None, msg("transcriber/out/S1/7/partial", {"segmentId": 1, "text": "a"}))
    bc._on_message(None, None, msg("transcriber/out/S1/7/final/translations", {"segmentId": 1, "text": "b", "targetLang": "en"}))
    # Unknown channel / non-caption topic: ignored, no crash.
    bc._on_message(None, None, msg("transcriber/out/S9/9/final", {"segmentId": 1, "text": "z"}))
    bc._on_message(None, None, msg("transcriber/out/S1/7/bogus", {"segmentId": 1, "text": "z"}))

    # Drain the coroutines scheduled onto the loop.
    bc.loop.run_until_complete(asyncio.sleep(0))
    bc.loop.run_until_complete(asyncio.sleep(0))
    bc.loop.close()

    assert calls == [
        ({"segmentId": 1, "text": "a"}, "partial", False),
        ({"segmentId": 1, "text": "b", "targetLang": "en"}, "final", True),
    ]
    assert BrokerClient._caption_topic("S1", 7) == "transcriber/out/S1/7/#"


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok  {name}")
    print("all captions tests passed")
