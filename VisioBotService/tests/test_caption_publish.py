"""Standalone tests for LiveKitBot.publish_caption — the wiring between the
Transcriber captions and the in-room transcription overlay:

  - segment ids are namespaced per CHANNEL (two channels of one session share
    the room), and the per-ASR-connection clocks are reconciled onto one
    timeline — in PER-STREAM too, where each participant's sub-ASR has its own
    `astart` and its own offsets (the Transcriber's timeline map adds back the
    VAD-elided silence but never re-origins), so a late joiner would otherwise be
    captioned at the meeting start;
  - a caption whose speaker just left is still attributed to that participant
    (with their last track sid), not to the bot's HIDDEN identity;
  - a truly unattributable caption is published under the bot identity but says
    so ONCE, and publish_transcription failures are throttled instead of logging
    one line per caption for the rest of the call;
  - `room.local_participant` RAISES before connect (it never returns None), so
    the guard has to be a try/except.

Run:  python3 VisioBotService/tests/test_caption_publish.py
(or via pytest:  pytest VisioBotService/tests/test_caption_publish.py)
"""
import asyncio
import datetime
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
    mod = types.ModuleType(name)
    for k, v in attrs.items():
        setattr(mod, k, v)
    sys.modules[name] = mod
    return mod


class _Transcription:
    def __init__(self, participant_identity, track_sid, segments):
        self.participant_identity = participant_identity
        self.track_sid = track_sid
        self.segments = segments


class _TranscriptionSegment:
    def __init__(self, id, text, start_time, end_time, language, final):
        self.id = id
        self.text = text
        self.start_time = start_time
        self.end_time = end_time
        self.language = language
        self.final = final


_lk = _stub("livekit")
_rtc = _stub("livekit.rtc", Room=object, AudioStream=object,
             TrackKind=types.SimpleNamespace(KIND_AUDIO="audio"),
             TrackSource=types.SimpleNamespace(SOURCE_UNKNOWN=0, SOURCE_MICROPHONE=2),
             RoomOptions=object, Transcription=_Transcription,
             TranscriptionSegment=_TranscriptionSegment)
_lk.rtc = _rtc
_stub("livekit.api", AccessToken=object, VideoGrants=object)
_stub("websockets", connect=None)

import bot.livekit_bot as livekit_bot_mod  # noqa: E402
from bot.captions import SegmentClock  # noqa: E402
from bot.livekit_bot import CAPTION_ERROR_WARN_EVERY, LiveKitBot  # noqa: E402


def _patch_rtc():
    """The whole suite shares one process and every test module stubs `livekit`,
    so whichever stub was imported first wins: patch the module object
    bot.livekit_bot actually holds, per test."""
    livekit_bot_mod.rtc.Transcription = _Transcription
    livekit_bot_mod.rtc.TranscriptionSegment = _TranscriptionSegment


# --- helpers -----------------------------------------------------------------
class _Local:
    identity = "linto-visio-bot-room-1-sess-1,0"

    def __init__(self, fail=False):
        self.published = []
        self.fail = fail

    async def publish_transcription(self, transcription):
        if self.fail:
            raise RuntimeError("data channel closed")
        self.published.append(transcription)


class _Room:
    def __init__(self, local=None, raises=False):
        self._local = local
        self._raises = raises

    @property
    def local_participant(self):
        if self._raises:
            raise Exception("cannot access local participant before connecting")
        return self._local


def _make_bot(per_stream=False, local=None, raises=False, stream_key="sess-1,0",
              clock_anchor=None):
    _patch_rtc()
    bot = LiveKitBot.__new__(LiveKitBot)
    bot.publish_captions = True
    bot.room_name = "room-1"
    bot._stream_key = stream_key
    # Production seeds the clock with the bot's own join instant
    # (LiveKitBot._t0_epoch_ms); pass `clock_anchor` to exercise that.
    bot._t0_epoch_ms = clock_anchor
    bot._segment_clock = SegmentClock(anchor_ms=clock_anchor)
    bot._participants = {"id-alice": "Alice"}
    bot._track_sids = {"id-alice": "TR_alice"}
    bot._departed = {}
    bot._departed_sids = {}
    bot._captions_published = 0
    bot._caption_errors = 0
    bot._unattributed_captions = 0
    bot.transcriber = types.SimpleNamespace(per_stream=per_stream)
    bot.room = _Room(local if local is not None else _Local(), raises=raises)
    return bot


def _publish(bot, payload, kind="final", is_translation=False):
    buf = io.StringIO()
    with redirect_stdout(buf):
        asyncio.run(bot.publish_caption(payload, kind, is_translation))
    return buf.getvalue()


# --- tests -------------------------------------------------------------------
def test_published_segment_id_carries_the_channel():
    local = _Local()
    bot = _make_bot(local=local)
    _publish(bot, {"segmentId": 7, "text": "bonjour", "start": 1.0, "end": 2.0,
                   "lang": "fr", "participantId": "id-alice"})
    assert len(local.published) == 1
    tr = local.published[0]
    assert tr.segments[0].id == "linto:sess-1,0:7"
    assert tr.participant_identity == "id-alice"
    assert tr.track_sid == "TR_alice"
    print("ok: the republished segment id is namespaced per channel")


def test_legacy_captions_share_one_timeline_across_asr_connections():
    local = _Local()
    bot = _make_bot(local=local)
    common = {"text": "x", "participantId": "id-alice", "lang": "fr"}
    _publish(bot, dict(common, segmentId=1, start=1.0, end=2.0,
                       astart="2026-01-01T10:00:00.000Z"))
    _publish(bot, dict(common, segmentId=1, start=0.0, end=1.0,
                       astart="2026-01-01T10:00:30.000Z"))
    starts = [t.segments[0].start_time for t in local.published]
    assert starts == [1000, 30000], starts
    print("ok: an ASR reconnect no longer sends the overlay time backwards")


def test_perstream_captions_are_rebased_onto_the_meeting_timeline():
    """Per-stream captions need the SegmentClock just as much as legacy ones.

    The Transcriber's per-sub-ASR timeline map is NOT meeting-absolute: it is
    seeded at that sub-ASR's own first frame (cumulativeGapMs starts at 0 and the
    first frame's meetingTimeMs is discarded), and _applyTimeline only adds back
    the VAD-elided silence — it never re-origins. So a per-stream caption's
    start/end stay anchored on its OWN `astart`, exactly like a legacy one, and
    the meeting-wide anchoring is the consumer's job (Session-API does the same
    thing with `(astart - MIN(astart)) + start`).

    Exempting per-stream collapsed every speaker onto t=0: a LATE JOINER who first
    speaks five minutes in was captioned at the meeting start."""
    local = _Local()
    bot = _make_bot(per_stream=True, local=local)
    common = {"text": "x", "start": 0.0, "end": 1.0, "participantId": "id-alice"}
    # Alice's sub-ASR started at the top of the meeting...
    _publish(bot, dict(common, segmentId=1, astart="2026-01-01T10:00:00.000Z"))
    # ...Bob's only when he first spoke, five minutes in. Both report start=0.
    _publish(bot, dict(common, segmentId=2, astart="2026-01-01T10:05:00.000Z"))
    starts = [t.segments[0].start_time for t in local.published]
    ends = [t.segments[0].end_time for t in local.published]
    assert starts == [0, 300000], starts
    assert ends == [1000, 301000], ends
    print("ok: a per-stream late joiner is captioned at their real meeting time")


def test_perstream_captions_are_anchored_on_the_bot_join_not_the_first_caption():
    """The first caption the bot SEES is not reliably the earliest sub-ASR.

    A sub-ASR is created on the first VAD-PASSING frame (an above-threshold cough
    or room tone is enough), but a caption only exists once the provider
    recognises TEXT. So Alice, present and gated-open from the join, can publish
    her first caption AFTER Bob, who only joined the conversation ten minutes in.
    Anchoring on Bob then clamped Alice's whole stream to offset 0 and the
    overlay spaced the two speakers by 1500 s instead of the real 900 s.

    The clock is therefore seeded with the bot's own join instant, which every
    sub-ASR of this channel provably starts after (they are created lazily on the
    first tagged frame the bot sends)."""
    join = int(
        datetime.datetime.fromisoformat("2026-01-01T10:00:00+00:00").timestamp() * 1000
    )
    local = _Local()
    bot = _make_bot(per_stream=True, local=local, clock_anchor=join)
    bot._participants = {"id-alice": "Alice", "id-bob": "Bob"}
    bot._track_sids = {"id-alice": "TR_alice", "id-bob": "TR_bob"}
    # Bob's sub-ASR opened when he first spoke, 10 min in; he is captioned at once.
    _publish(bot, {"segmentId": 1, "text": "b", "start": 0.0, "end": 1.0,
                   "participantId": "id-bob",
                   "astart": "2026-01-01T10:10:00.000Z"})
    # Alice's sub-ASR opened at the join (a cough opened the gate) but her first
    # recognised words only land 25 min in.
    _publish(bot, {"segmentId": 1, "text": "a", "start": 1500.0, "end": 1501.0,
                   "participantId": "id-alice",
                   "astart": "2026-01-01T10:00:00.000Z"})
    starts = [t.segments[0].start_time for t in local.published]
    assert starts == [600000, 1500000], starts
    assert starts[1] - starts[0] == 900000  # the real separation, not 1500 s
    print("ok: the caption clock is anchored on the bot join, not the first caption")


def test_the_caption_clock_does_not_depend_on_the_link_state():
    """`transcriber.per_stream` is a LINK-state flag: a socket close clears it for
    the whole reconnect window, and captions keep arriving over MQTT in that gap
    (the Transcriber flushes each sub-ASR's trailing finals on exactly the close
    that caused it). Reading it at publish time made those captions take a
    different timeline than their neighbours; the publish path must not read it at
    all."""
    local = _Local()
    bot = _make_bot(per_stream=True, local=local)
    common = {"text": "x", "start": 0.0, "end": 1.0, "participantId": "id-alice"}
    _publish(bot, dict(common, segmentId=1, astart="2026-01-01T10:00:00.000Z"))
    # The link drops mid-call: per_stream is transiently cleared...
    bot.transcriber.per_stream = False
    _publish(bot, dict(common, segmentId=2, astart="2026-01-01T10:05:00.000Z"))
    # ...and comes back on the reconnect.
    bot.transcriber.per_stream = True
    _publish(bot, dict(common, segmentId=3, astart="2026-01-01T10:10:00.000Z"))
    starts = [t.segments[0].start_time for t in local.published]
    assert starts == [0, 300000, 600000], starts
    print("ok: the caption timeline is unaffected by the transient link state")


def test_a_caption_for_a_departed_speaker_keeps_their_identity():
    local = _Local()
    bot = _make_bot(local=local)
    bot._participants.clear()
    bot._departed["id-alice"] = "Alice"
    bot._departed_sids["id-alice"] = "TR_alice"
    bot._track_sids.clear()
    out = _publish(bot, {"segmentId": 9, "text": "au revoir", "locutor": "Alice"})
    tr = local.published[0]
    assert tr.participant_identity == "id-alice"
    assert tr.track_sid == "TR_alice"
    assert "WARNING" not in out, out
    print("ok: a final landing after the speaker left keeps their attribution")


def test_an_unattributable_caption_warns_once():
    local = _Local()
    bot = _make_bot(local=local)
    payload = {"segmentId": 1, "text": "?", "locutor": "Guest-3"}
    first = _publish(bot, payload)
    second = _publish(bot, dict(payload, segmentId=2))
    assert local.published[0].participant_identity == local.identity
    assert "WARNING" in first and "hidden identity" in first, first
    assert "WARNING" not in second, "the warning must not repeat per caption"
    assert bot._unattributed_captions == 2
    print("ok: an unattributable caption is flagged once, not lost silently")


def test_publish_failures_are_throttled():
    local = _Local(fail=True)
    bot = _make_bot(local=local)
    buf = io.StringIO()
    with redirect_stdout(buf):
        async def drive():
            for i in range(CAPTION_ERROR_WARN_EVERY + 5):
                await bot.publish_caption(
                    {"segmentId": i, "text": "x", "participantId": "id-alice"},
                    "partial", False,
                )
        asyncio.run(drive())
    lines = buf.getvalue().count("publish_transcription failed")
    assert bot._caption_errors == CAPTION_ERROR_WARN_EVERY + 5
    assert lines == 2, lines  # the first, then one per CAPTION_ERROR_WARN_EVERY
    print(f"ok: {bot._caption_errors} failures produced {lines} log line(s)")


def test_publish_before_connect_is_a_noop():
    bot = _make_bot(raises=True)
    # room.local_participant RAISES here — the old `getattr(..., None)` guard was
    # dead code and this would have blown up inside the caption path.
    out = _publish(bot, {"segmentId": 1, "text": "x", "participantId": "id-alice"})
    assert out == "", out
    print("ok: a caption arriving before the room is connected is dropped cleanly")


def test_disabled_publishing_short_circuits():
    local = _Local()
    bot = _make_bot(local=local)
    bot.publish_captions = False
    _publish(bot, {"segmentId": 1, "text": "x", "participantId": "id-alice"})
    assert local.published == []


_TESTS = [
    test_published_segment_id_carries_the_channel,
    test_legacy_captions_share_one_timeline_across_asr_connections,
    test_perstream_captions_are_rebased_onto_the_meeting_timeline,
    test_perstream_captions_are_anchored_on_the_bot_join_not_the_first_caption,
    test_the_caption_clock_does_not_depend_on_the_link_state,
    test_a_caption_for_a_departed_speaker_keeps_their_identity,
    test_an_unattributable_caption_warns_once,
    test_publish_failures_are_throttled,
    test_publish_before_connect_is_a_noop,
    test_disabled_publishing_short_circuits,
]


def main():
    for t in _TESTS:
        t()
    print(f"\nALL {len(_TESTS)} TESTS PASSED")


if __name__ == "__main__":
    main()
