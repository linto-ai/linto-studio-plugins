"""Caption → LiveKit transcription-segment mapping (pure logic, no SDK import).

The native visio bot republishes the Transcriber's live captions INTO the LiveKit
room as standard transcription segments (``publish_transcription``), so the
Visio/Meet frontend renders them through its native caption overlay — no
side-channel (socket.io / polling) needed in the browser.

Wire (MQTT, published by the Transcriber):
  transcriber/out/<sessionId>/<channelId>/partial | final
      {segmentId, astart, text, start, end, lang, locutor, participantId?}
  transcriber/out/<sessionId>/<channelId>/partial/translations | final/translations
      {segmentId, astart, text, start, end, sourceLang, targetLang, locutor, final, mode}

Segment ids are namespaced so a consumer can tell captions apart from any other
transcription source in the room, pair a translation with its source line, AND
tell two CHANNELS of the same meeting apart:
  original     -> "linto:<channelKey>:<segmentId>"
  translation  -> "linto:<channelKey>:<segmentId>:<targetLang>"
`channelKey` identifies the Transcriber stream this bot serves (the
`<sessionId>,<channelIndex>` tail of its ingest URL). It is REQUIRED for
correctness whenever more than one channel of a session shares one LiveKit room
(a multi-language session): segmentIds restart at 1 per ASR connection, so
without it the two channels upsert each other's captions in the overlay. It
stays optional here so a caller with no channel context still maps cleanly.
Partials and the final of the SAME utterance share one segmentId (Transcriber
contract), so the client upserts by id: partial text is replaced in place until
the final lands.
"""
from datetime import datetime, timezone

SEGMENT_ID_PREFIX = "linto"


def topic_kind(topic: str):
    """Classify a Transcriber MQTT topic.

    Returns ``(session_id, channel_id, kind, is_translation)`` with ``kind`` in
    {"partial", "final"}, or ``None`` when the topic is not a caption topic.
    """
    parts = topic.split("/")
    # transcriber/out/<sid>/<cid>/<partial|final>[/translations]
    if len(parts) < 5 or parts[0] != "transcriber" or parts[1] != "out":
        return None
    kind = parts[4]
    if kind not in ("partial", "final"):
        return None
    is_translation = len(parts) >= 6 and parts[5] == "translations"
    if len(parts) > 6 or (len(parts) == 6 and not is_translation):
        return None
    return parts[2], parts[3], kind, is_translation


def _ms(value) -> int:
    """Seconds (float/int/str, relative to stream start) -> non-negative int ms."""
    try:
        return max(0, int(round(float(value) * 1000)))
    except (TypeError, ValueError):
        return 0


def _epoch_ms(value):
    """`astart` (ISO-8601 string, or an epoch number) -> epoch ms, else None."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        # Epoch seconds vs milliseconds, resolved on magnitude (1e11 ms is 1973,
        # 1e11 s is year 5138 — no realistic timestamp is ambiguous).
        return int(value * 1000) if value < 1e11 else int(value)
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return int(parsed.timestamp() * 1000)


class SegmentClock:
    """One room-wide millisecond timeline for the republished segments.

    A caption's `start`/`end` are seconds relative to the ASR CONNECTION that
    produced it, and `astart` is that connection's wall-clock start. Publishing
    `start` as-is is wrong in two ways:
      - legacy mixed path: an ASR reconnect mid-session restarts `start` at 0,
        so the overlay times jump BACKWARDS at the reconnect;
      - per-stream: every participant has its own sub-ASR started when they first
        spoke, so the same numbers are not comparable BETWEEN speakers.

    Fix: anchor on an origin at or before the earliest ASR connection and add
    `astart - anchor` to the caption's own offsets, which puts every ASR
    connection of this bot on one monotonic timeline. This is the in-room
    overlay's equivalent of Session-API's `(astart - MIN(astart)) + start`
    rebase.

    ``anchor_ms`` is that origin (epoch ms). The bot passes its OWN join instant:
    every sub-ASR of the channel is created lazily on the first tagged frame the
    bot sends, hence strictly after the join, so the join is provably no later
    than any `astart`. Anchoring instead on the first caption SEEN is not safe in
    per-stream: a sub-ASR is created on the first VAD-passing frame, but a
    caption only exists once the provider recognises TEXT, so a participant
    present from the start who speaks late can arrive second and see every
    earlier-anchored stream clamped to 0. With no ``anchor_ms`` the first
    `astart` seen still seeds the anchor (fine for the legacy single-ASR path,
    where the first connection is the earliest one by construction).

    The anchor is also LOWERED whenever an earlier `astart` shows up, so a clock
    skew between the bot's host and the Transcriber's degrades into a constant
    shift rather than collapsing every offset onto the 0 clamp.

    ``meeting_relative=True`` is for a producer that already publishes
    MEETING-ORIGIN offsets, and adding `astart` on top would double-count. The
    Transcriber is NOT such a producer, in either mode: its per-sub-ASR timeline
    map is seeded at that sub-ASR's own first frame (`_noteMeetingTime` starts
    cumulativeGapMs at 0 and discards that frame's absolute meetingTimeMs) and
    `_applyTimeline` only ADDS BACK the silence the bot's VAD gate elided from
    inside that one stream — it never re-origins. Offsets therefore stay anchored
    on each connection's own `astart`, so the per-stream bot path passes False
    too; see ``LiveKitBot.publish_caption``.
    """

    def __init__(self, anchor_ms: int | None = None) -> None:
        usable = isinstance(anchor_ms, (int, float)) and not isinstance(
            anchor_ms, bool
        )
        self._anchor_ms: int | None = int(anchor_ms) if usable else None

    def offset_ms(self, payload) -> int:
        if not isinstance(payload, dict):
            return 0
        base = _epoch_ms(payload.get("astart"))
        if base is None:
            return 0
        if self._anchor_ms is None or base < self._anchor_ms:
            self._anchor_ms = base
        return max(0, base - self._anchor_ms)


def caption_to_segment(
    payload: dict,
    kind: str,
    is_translation: bool,
    channel_key=None,
    clock: "SegmentClock | None" = None,
    meeting_relative: bool = False,
):
    """Map one caption payload to a ``(segment_id, text, start_ms, end_ms, language,
    final)`` tuple, or ``None`` when the payload carries nothing publishable.

    ``kind`` is the topic kind ("partial"/"final"); for translations the payload's
    own ``final`` flag is authoritative when present.

    ``channel_key`` namespaces the segment id per Transcriber stream (see the
    module docstring); ``clock`` reconciles the per-ASR connection clocks onto
    one room-wide timeline, and ``meeting_relative=True`` bypasses it for a
    producer that already publishes meeting-origin offsets — which the
    Transcriber is not, in either mode (see ``SegmentClock``).
    """
    if not isinstance(payload, dict):
        return None
    text = payload.get("text")
    if not isinstance(text, str) or not text.strip():
        return None
    seg = payload.get("segmentId")
    if seg is None or seg == "":
        return None
    prefix = (
        f"{SEGMENT_ID_PREFIX}:{channel_key}" if channel_key else SEGMENT_ID_PREFIX
    )
    segment_id = f"{prefix}:{seg}"
    final = kind == "final"
    if is_translation:
        target = payload.get("targetLang")
        if not target:
            return None
        segment_id = f"{segment_id}:{target}"
        language = str(target)
        if isinstance(payload.get("final"), bool):
            final = payload["final"]
    else:
        language = str(payload.get("lang") or "")
    start_ms = _ms(payload.get("start"))
    end_ms = _ms(payload.get("end"))
    if end_ms < start_ms:
        end_ms = start_ms
    if clock is not None and not meeting_relative:
        offset = clock.offset_ms(payload)
        start_ms += offset
        end_ms += offset
    return segment_id, text, start_ms, end_ms, language, final


def resolve_speaker(
    payload: dict, participants: dict, bot_identity: str, departed=None
) -> str:
    """Pick the LiveKit identity the caption is attributed to.

    Order: the Transcriber's stable ``participantId`` (a LiveKit identity for the
    native bot) when it is a known participant; else a reverse lookup of the
    ``locutor`` display name (unique per D8); else the bot's own identity (the
    client then shows an unattributed line rather than dropping it).

    ``departed`` is the same shape as ``participants`` and holds RECENTLY LEFT
    identities. A final routinely lands after its speaker hung up (the ASR flush
    is asynchronous), and the bot itself joins HIDDEN — so falling back to the
    bot identity there hides the caption from every client that resolves the
    segment's participant. The departed map keeps those last words attributed to
    the person who actually said them.
    """
    pid = payload.get("participantId") if isinstance(payload, dict) else None
    if isinstance(pid, str) and pid:
        if pid in participants:
            return pid
        if departed and pid in departed:
            return pid
    locutor = payload.get("locutor") if isinstance(payload, dict) else None
    if isinstance(locutor, str) and locutor:
        for ident, name in participants.items():
            if name == locutor:
                return ident
        if locutor in participants:
            return locutor
        if departed:
            for ident, name in departed.items():
                if name == locutor:
                    return ident
            if locutor in departed:
                return locutor
    return bot_identity
