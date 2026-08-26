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
transcription source in the room and pair a translation with its source line:
  original     -> "linto:<segmentId>"
  translation  -> "linto:<segmentId>:<targetLang>"
Partials and the final of the SAME utterance share one segmentId (Transcriber
contract), so the client upserts by id: partial text is replaced in place until
the final lands.
"""

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


def caption_to_segment(payload: dict, kind: str, is_translation: bool):
    """Map one caption payload to a ``(segment_id, text, start_ms, end_ms, language,
    final)`` tuple, or ``None`` when the payload carries nothing publishable.

    ``kind`` is the topic kind ("partial"/"final"); for translations the payload's
    own ``final`` flag is authoritative when present.
    """
    if not isinstance(payload, dict):
        return None
    text = payload.get("text")
    if not isinstance(text, str) or not text.strip():
        return None
    seg = payload.get("segmentId")
    if seg is None or seg == "":
        return None
    segment_id = f"{SEGMENT_ID_PREFIX}:{seg}"
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
    return segment_id, text, start_ms, end_ms, language, final


def resolve_speaker(payload: dict, participants: dict, bot_identity: str) -> str:
    """Pick the LiveKit identity the caption is attributed to.

    Order: the Transcriber's stable ``participantId`` (a LiveKit identity for the
    native bot) when it is a known participant; else a reverse lookup of the
    ``locutor`` display name (unique per D8); else the bot's own identity (the
    client then shows an unattributed line rather than dropping it).
    """
    pid = payload.get("participantId") if isinstance(payload, dict) else None
    if isinstance(pid, str) and pid in participants:
        return pid
    locutor = payload.get("locutor") if isinstance(payload, dict) else None
    if isinstance(locutor, str) and locutor:
        for ident, name in participants.items():
            if name == locutor:
                return ident
        if locutor in participants:
            return locutor
    return bot_identity
