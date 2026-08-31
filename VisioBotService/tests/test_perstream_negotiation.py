"""Standalone tests for the per-stream mode contract of the native Visio bot:

  1. BOT_PERSTREAM defaults to per-stream (this service's validated mode) and is
     opt-OUT via BOT_PERSTREAM=false.
  2. The Transcriber's ack decides the EFFECTIVE mode, and a denied request logs a
     loud warning instead of degrading to the mixed path silently.
  3. The init frame carries an empty participant roster (the room is joined after
     the handshake; the roster arrives as `participant/join` control messages).
  4. Audio is queued straight onto the single-writer queue — there is no pre-ack
     buffer, because no audio can exist before the ack.

Runs WITHOUT the heavy runtime deps by stubbing livekit / websockets, like the
sibling tag-allocator tests.

Run:  python3 VisioBotService/tests/test_perstream_negotiation.py
(or via pytest:  pytest VisioBotService/tests/test_perstream_negotiation.py)
"""
import asyncio
import io
import json
import os
import sys
import types
from contextlib import redirect_stdout

# --- make `bot` importable and stub the not-installed runtime deps -----------
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


_lk = _stub("livekit")
_rtc = _stub("livekit.rtc", Room=object, AudioStream=object,
             TrackKind=types.SimpleNamespace(KIND_AUDIO="audio"),
             RoomOptions=object)
_lk.rtc = _rtc
_stub("livekit.api", AccessToken=object, VideoGrants=object)
_stub("websockets", connect=None)

from bot.livekit_bot import LiveKitBot  # noqa: E402
from bot.transcriber_stream import TranscriberStream  # noqa: E402


# --- helpers -----------------------------------------------------------------
def _bot(**env):
    """Build a real LiveKitBot with a controlled environment."""
    saved = {k: os.environ.get(k) for k in env}
    os.environ.update({k: v for k, v in env.items() if v is not None})
    for k, v in env.items():
        if v is None:
            os.environ.pop(k, None)
    try:
        return LiveKitBot("ws://lk", "room", "ws://transcriber")
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


class FakeWs:
    """Captures what the stream sends, so the init frame can be asserted."""

    def __init__(self):
        self.sent = []

    async def send(self, payload):
        self.sent.append(payload)


def _ack(stream, per_stream):
    """Feed one ack message through the real _recv() handling, capturing stdout."""
    buf = io.StringIO()

    async def drive():
        stream.ws = _AckOnce(json.dumps({"type": "ack", "perStream": per_stream}))
        await stream._recv()

    with redirect_stdout(buf):
        asyncio.run(drive())
    return buf.getvalue()


class _AckOnce:
    """Async-iterable websocket yielding a single message then closing."""

    def __init__(self, message):
        self.message = message

    def __aiter__(self):
        async def gen():
            yield self.message
        return gen()


# --- tests -------------------------------------------------------------------
def test_perstream_is_the_default():
    bot = _bot(BOT_PERSTREAM=None)
    assert bot.requested_per_stream is True, "per-stream must be the default mode"
    assert bot.transcriber.requested_per_stream is True
    print("OK per-stream is the default when BOT_PERSTREAM is unset")


def test_perstream_explicit_true():
    for value in ("true", "TRUE", " true ", "1"):
        bot = _bot(BOT_PERSTREAM=value)
        assert bot.requested_per_stream is True, value
    print("OK BOT_PERSTREAM=true/1 keeps per-stream")


def test_perstream_opt_out():
    for value in ("false", "FALSE", "0", "no"):
        bot = _bot(BOT_PERSTREAM=value)
        assert bot.requested_per_stream is False, value
    print("OK BOT_PERSTREAM=false opts out to the legacy mixed path")


def test_ack_grants_perstream_quietly():
    stream = TranscriberStream("ws://t", per_stream=True)
    out = _ack(stream, per_stream=True)
    assert stream.per_stream is True
    assert stream.ready is True
    assert "WARNING" not in out, out
    print("OK a granted ack enables per-stream with no warning")


def test_denied_ack_warns_loudly():
    stream = TranscriberStream("ws://t", per_stream=True)
    out = _ack(stream, per_stream=False)
    assert stream.per_stream is False, "the bot must honour the ack, not its request"
    assert "WARNING" in out and "TRANSCRIBER_PERSTREAM_DIARIZATION" in out, out
    print("OK a denied ack falls back to mixed AND warns with the fix")


def test_mixed_request_does_not_warn():
    stream = TranscriberStream("ws://t", per_stream=False)
    out = _ack(stream, per_stream=False)
    assert stream.per_stream is False
    assert "WARNING" not in out, out
    print("OK a bot that never asked for per-stream stays silent")


def test_init_frame_has_empty_roster():
    stream = TranscriberStream("ws://t", diarization_mode="native", per_stream=True)
    ws = FakeWs()
    stream.ws = ws
    asyncio.run(stream._send_init())
    init = json.loads(ws.sent[0])
    assert init["type"] == "init"
    assert init["perStream"] is True
    assert init["diarizationMode"] == "native"
    assert init["participants"] == [], "the room is joined only after the handshake"
    print("OK the init frame advertises the mode with an empty roster")


def test_audio_is_not_buffered_before_the_ack():
    stream = TranscriberStream("ws://t", per_stream=True)
    assert not hasattr(stream, "buffer"), "the dead pre-ack ring buffer must be gone"

    async def drive():
        stream.enqueue(b"\x00\x01")
        stream.enqueue_tagged(3, 1234, b"\x02\x03")
        return [stream.q.get_nowait() for _ in range(stream.q.qsize())]

    frames = asyncio.run(drive())
    assert len(frames) == 2, frames
    assert frames[0] == b"\x00\x01"
    # tagged frame = MAGIC 0x01 | tag | reserved u16 | tMs u32 LE | PCM
    assert frames[1] == bytes([0x01, 3, 0, 0]) + (1234).to_bytes(4, "little") + b"\x02\x03"
    print("OK audio goes straight to the single-writer queue (no pre-ack buffer)")


def test_closed_stream_drops_audio():
    stream = TranscriberStream("ws://t")

    async def drive():
        stream._closed = True
        stream.enqueue(b"\x00")
        return stream.q.qsize()

    assert asyncio.run(drive()) == 0
    print("OK a closed stream still drops audio instead of queueing it")


_TESTS = [
    test_perstream_is_the_default,
    test_perstream_explicit_true,
    test_perstream_opt_out,
    test_ack_grants_perstream_quietly,
    test_denied_ack_warns_loudly,
    test_mixed_request_does_not_warn,
    test_init_frame_has_empty_roster,
    test_audio_is_not_buffered_before_the_ack,
    test_closed_stream_drops_audio,
]


def main():
    for t in _TESTS:
        t()
    print(f"\nALL {len(_TESTS)} TESTS PASSED")


if __name__ == "__main__":
    main()
