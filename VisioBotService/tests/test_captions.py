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

from bot.captions import (  # noqa: E402
    SegmentClock,
    caption_to_segment,
    resolve_speaker,
    topic_kind,
)


def _epoch(iso: str) -> int:
    """ISO-8601 -> epoch ms (the shape LiveKitBot._t0_epoch_ms carries)."""
    from datetime import datetime
    return int(datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000)


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


# ---- per-CHANNEL namespacing ------------------------------------------------
def test_segment_ids_are_namespaced_per_channel():
    """Two channels of one session share a LiveKit room and both restart their
    segmentIds at 1 — without the channel key they upsert each other's lines."""
    payload = {"segmentId": 12, "text": "bonjour", "start": 1.0, "end": 2.0, "lang": "fr"}
    a = caption_to_segment(payload, "final", False, channel_key="sess-1,0")
    b = caption_to_segment(payload, "final", False, channel_key="sess-1,1")
    assert a[0] == "linto:sess-1,0:12"
    assert b[0] == "linto:sess-1,1:12"
    assert a[0] != b[0]
    # Translations stay namespaced by target language on top of the channel.
    tr = dict(payload, targetLang="en")
    assert caption_to_segment(tr, "final", True, channel_key="sess-1,0")[0] == (
        "linto:sess-1,0:12:en"
    )
    # No channel key -> the plain id (a caller with no channel context).
    assert caption_to_segment(payload, "final", False)[0] == "linto:12"


# ---- one timeline across ASR connections ------------------------------------
def test_segment_clock_puts_every_asr_connection_on_one_timeline():
    clock = SegmentClock()
    first = {"segmentId": 1, "text": "a", "start": 1.0, "end": 2.0,
             "astart": "2026-01-01T10:00:00.000Z"}
    # A second ASR connection, started 30 s later, restarts `start` at 0.
    second = {"segmentId": 1, "text": "b", "start": 0.0, "end": 1.0,
              "astart": "2026-01-01T10:00:30.000Z"}
    a = caption_to_segment(first, "final", False, clock=clock)
    b = caption_to_segment(second, "final", False, clock=clock)
    assert (a[2], a[3]) == (1000, 2000)
    # Without the clock this would be 0 — a jump BACKWARDS in the overlay.
    assert (b[2], b[3]) == (30000, 31000)
    assert b[2] > a[2]


def test_segment_clock_never_produces_a_negative_offset():
    clock = SegmentClock()
    clock.offset_ms({"astart": "2026-01-01T10:00:30.000Z"})  # anchor
    earlier = {"segmentId": 2, "text": "x", "start": 1.0, "end": 1.5,
               "astart": "2026-01-01T10:00:00.000Z"}
    seg = caption_to_segment(earlier, "final", False, clock=clock)
    assert (seg[2], seg[3]) == (1000, 1500), seg


def test_meeting_relative_captions_bypass_the_clock():
    """`meeting_relative=True` is for a producer that already publishes
    MEETING-ORIGIN offsets, where adding `astart` would double-count.

    The Transcriber is NOT such a producer in EITHER mode: its per-sub-ASR
    timeline map is seeded at that sub-ASR's own first frame and only adds back
    the VAD-elided silence, so offsets stay anchored on each connection's own
    `astart`. Both bot paths therefore pass False (see the per-stream test in
    test_caption_publish.py); this only pins the flag's own semantics."""
    clock = SegmentClock()
    clock.offset_ms({"astart": "2026-01-01T10:00:00.000Z"})
    payload = {"segmentId": 3, "text": "y", "start": 12.0, "end": 13.0,
               "astart": "2026-01-01T10:05:00.000Z"}
    seg = caption_to_segment(payload, "final", False, clock=clock, meeting_relative=True)
    assert (seg[2], seg[3]) == (12000, 13000)


def test_segment_clock_anchors_on_the_supplied_origin_not_the_first_caption():
    """The FIRST caption seen is not reliably the earliest ASR connection.

    In per-stream a sub-ASR is created on the first VAD-PASSING frame (a cough is
    enough) but a caption only exists once the provider recognises TEXT, so a
    participant present from the start who speaks late can arrive second. Seeded
    with the bot's own join instant (LiveKitBot._t0_epoch_ms, provably no later
    than any `astart`), the clock keeps the two apart instead of clamping the
    earlier connection onto 0."""
    join = _epoch("2026-01-01T10:00:00.000Z")
    clock = SegmentClock(anchor_ms=join)
    # Bob only speaks 10 min in, but he is the first caption the bot ever sees.
    bob = {"segmentId": 1, "text": "b", "start": 0.0, "end": 1.0,
           "astart": "2026-01-01T10:10:00.000Z"}
    # Alice's sub-ASR opened at the join; she is captioned 25 min in.
    alice = {"segmentId": 2, "text": "a", "start": 1500.0, "end": 1501.0,
             "astart": "2026-01-01T10:00:00.000Z"}
    b = caption_to_segment(bob, "final", False, clock=clock)
    a = caption_to_segment(alice, "final", False, clock=clock)
    assert (b[2], b[3]) == (600000, 601000), b
    assert (a[2], a[3]) == (1500000, 1501000), a
    # Real separation is 900 s; a first-caption anchor rendered it as 1500 s.
    assert a[2] - b[2] == 900000


def test_segment_clock_lowers_its_anchor_for_an_earlier_astart():
    """Host-clock skew between the bot and the Transcriber must degrade into a
    constant shift, not collapse every offset onto the 0 clamp: an `astart`
    before the seeded anchor lowers the anchor instead of being clamped away."""
    clock = SegmentClock(anchor_ms=_epoch("2026-01-01T12:00:00.000Z"))  # skewed late
    first = {"segmentId": 1, "text": "a", "start": 0.0, "end": 1.0,
             "astart": "2026-01-01T10:00:00.000Z"}
    second = {"segmentId": 2, "text": "b", "start": 0.0, "end": 1.0,
              "astart": "2026-01-01T10:00:30.000Z"}
    a = caption_to_segment(first, "final", False, clock=clock)
    b = caption_to_segment(second, "final", False, clock=clock)
    assert (a[2], b[2]) == (0, 30000), (a, b)


def test_segment_clock_ignores_a_non_numeric_anchor():
    """A bogus anchor falls back to the first-`astart` seeding, never to a crash
    or to a bool coerced into 1 ms."""
    for bad in (None, True, "2026-01-01T10:00:00.000Z", object()):
        clock = SegmentClock(anchor_ms=bad)
        payload = {"segmentId": 1, "text": "a", "start": 2.0, "end": 3.0,
                   "astart": "2026-01-01T10:00:00.000Z"}
        seg = caption_to_segment(payload, "final", False, clock=clock)
        assert (seg[2], seg[3]) == (2000, 3000), bad


def test_segment_clock_passes_through_an_unusable_astart():
    clock = SegmentClock()
    for astart in (None, "", "not-a-date", {}):
        seg = caption_to_segment(
            {"segmentId": 4, "text": "z", "start": 2.0, "end": 3.0, "astart": astart},
            "final", False, clock=clock,
        )
        assert (seg[2], seg[3]) == (2000, 3000), astart


# ---- late (post-departure) attribution --------------------------------------
def test_resolve_speaker_falls_back_to_a_recently_departed_participant():
    """A final routinely lands after its speaker hung up, and the bot joins
    HIDDEN — attributing it to the bot hides those last words from the overlay."""
    participants = {"id-bob": "Bob"}
    departed = {"id-alice": "Alice"}
    assert resolve_speaker(
        {"participantId": "id-alice"}, participants, "bot", departed=departed
    ) == "id-alice"
    assert resolve_speaker(
        {"locutor": "Alice"}, participants, "bot", departed=departed
    ) == "id-alice"
    # A live participant still wins, and an unknown speaker still falls back.
    assert resolve_speaker(
        {"locutor": "Bob"}, participants, "bot", departed=departed
    ) == "id-bob"
    assert resolve_speaker(
        {"locutor": "Guest-9"}, participants, "bot", departed=departed
    ) == "bot"


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
