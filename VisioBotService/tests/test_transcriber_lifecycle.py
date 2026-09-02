"""Standalone tests for the Transcriber WS LIFECYCLE and the tagged wire format
(#C1/#C3/#C5/#C12 + the shared wire contract):

  1. A peer close is OBSERVED: ready/per_stream/mixed_recording are cleared and a
     bounded-backoff reconnect re-runs the init handshake on a fresh socket.
  2. The reconnect honours the NEW grant (a reconnect can land on another
     Transcriber instance), and drops the audio framed for the previous mode.
  3. Once the retries are exhausted, `on_failure` fires with the reason the
     BrokerClient publishes as botservice/out/<botId>/bot-error.
  4. The send queue is BOUNDED with priority drop-oldest: mixed recording frames
     go first, control frames never go, and the drops are logged once — not once
     per frame.
  5. A `{type:'error'}` handshake reply fails connect() at once instead of
     burning the whole ack watchdog.
  6. Wire contract: init advertises the `mixedRecording` CAPABILITY, the ack is
     the ONLY source of the effective mixed_recording, and enqueue_mixed() emits
     MAGIC 0x02 / tag 0 through the same frame builder as enqueue_tagged().

Runs WITHOUT the heavy runtime deps by stubbing livekit / websockets, like the
sibling per-stream negotiation tests.

Run:  python3 VisioBotService/tests/test_transcriber_lifecycle.py
(or via pytest:  pytest VisioBotService/tests/test_transcriber_lifecycle.py)
"""
import asyncio
import io
import json
import os
import sys
import time
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


_stub("websockets", connect=None)

import bot.transcriber_stream as ts_mod  # noqa: E402
from bot.transcriber_stream import TranscriberStream  # noqa: E402


# --- fakes -------------------------------------------------------------------
_EOF = object()


class FakeWs:
    """Async-iterable websocket double: `push()` feeds the recv loop, `end()`
    simulates the peer closing the socket."""

    def __init__(self):
        self.sent = []
        self.closed = False
        self._inbox: asyncio.Queue = asyncio.Queue()

    async def send(self, payload):
        if self.closed:
            raise ConnectionError("FakeWs: socket closed")
        self.sent.append(payload)

    def __aiter__(self):
        return self

    async def __anext__(self):
        item = await self._inbox.get()
        if item is _EOF:
            raise StopAsyncIteration
        return item

    def push(self, message):
        self._inbox.put_nowait(message)

    def end(self):
        """The peer closed: the async-for ends, exactly like `websockets` does."""
        self._inbox.put_nowait(_EOF)

    async def close(self):
        self.closed = True
        self.end()


def _ack_frame(per_stream=True, mixed_recording=False):
    return json.dumps(
        {
            "type": "ack",
            "message": "Init done",
            "perStream": per_stream,
            "mixedRecording": mixed_recording,
        }
    )


async def _settle(times=6):
    for _ in range(times):
        await asyncio.sleep(0)


async def _wait_for(predicate, timeout=2.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        await asyncio.sleep(0.005)
    return False


def _fast_stream(**kwargs):
    """A stream whose reconnect backoff is sub-millisecond, so the tests are fast."""
    stream = TranscriberStream("ws://transcriber", **kwargs)
    stream.reconnect_base_ms = 1
    return stream


class _Dialer:
    """Stands in for websockets.connect: hands out FakeWs sockets in order and
    can be told to fail the next N dials."""

    def __init__(self, fail_after=None):
        self.sockets = []
        self.attempts = 0
        self.fail_after = fail_after  # dial index (1-based) from which to fail

    async def __call__(self, url, **kwargs):
        self.attempts += 1
        if self.fail_after is not None and self.attempts >= self.fail_after:
            raise ConnectionRefusedError("transcriber unreachable")
        ws = FakeWs()
        self.sockets.append(ws)
        return ws


def _with_dialer(dialer, coro_factory):
    """Run `coro_factory()` with transcriber_stream.websockets.connect patched."""
    saved = ts_mod.websockets
    ts_mod.websockets = types.SimpleNamespace(connect=dialer)
    try:
        return asyncio.run(coro_factory())
    finally:
        ts_mod.websockets = saved


# --- lifecycle ---------------------------------------------------------------
def test_peer_close_clears_state_and_reconnects():
    dialer = _Dialer()
    buf = io.StringIO()

    async def drive():
        stream = _fast_stream(per_stream=True)
        task = asyncio.create_task(stream.connect())
        assert await _wait_for(lambda: dialer.sockets)
        dialer.sockets[0].push(_ack_frame(per_stream=True, mixed_recording=True))
        await task
        assert stream.ready is True
        assert stream.per_stream is True
        assert stream.mixed_recording is True

        # The Transcriber closes the socket (stopRunningSession / pod restart / LB).
        dialer.sockets[0].end()
        assert await _wait_for(lambda: stream.ready is False)
        assert stream.per_stream is False, "a dead link must not advertise a mode"
        assert stream.mixed_recording is False

        # Audio produced during the gap is buffered, not written into the void.
        stream.enqueue(b"gap-audio")
        assert stream.q.qsize() == 1

        assert await _wait_for(lambda: len(dialer.sockets) > 1), "no reconnect"
        dialer.sockets[1].push(_ack_frame(per_stream=True, mixed_recording=True))
        assert await _wait_for(lambda: stream.ready is True)
        assert stream.per_stream is True

        # The init handshake was re-run on the fresh socket...
        init = json.loads(dialer.sockets[1].sent[0])
        assert init["type"] == "init" and init["perStream"] is True
        # ...and the buffered frame was flushed to it, not to the dead one.
        assert await _wait_for(lambda: b"gap-audio" in dialer.sockets[1].sent)
        assert b"gap-audio" not in dialer.sockets[0].sent
        await stream.close()

    with redirect_stdout(buf):
        _with_dialer(dialer, drive)
    print("OK a peer close clears the negotiated state and reconnects")


def test_reconnect_honours_the_new_grant_and_drops_stale_audio():
    dialer = _Dialer()
    buf = io.StringIO()

    async def drive():
        stream = _fast_stream(per_stream=True)
        task = asyncio.create_task(stream.connect())
        assert await _wait_for(lambda: dialer.sockets)
        dialer.sockets[0].push(_ack_frame(per_stream=True))
        await task
        dialer.sockets[0].end()
        assert await _wait_for(lambda: stream.ready is False)

        # Tagged frames queued for the OLD (per-stream) grant.
        stream.enqueue_tagged(3, 100, b"\x01\x02")
        stream.send_participant("join", "p1", "Alice", 3)
        assert stream.q.qsize() == 2

        assert await _wait_for(lambda: len(dialer.sockets) > 1)
        # The replacement instance does NOT run per-stream diarization.
        dialer.sockets[1].push(_ack_frame(per_stream=False))
        assert await _wait_for(lambda: stream.ready is True)
        assert stream.per_stream is False, "the NEW ack decides, not the old grant"
        # The queued tagged frame would be decoded as raw PCM (header included) by
        # the new instance, so it is dropped; the control frame survives.
        assert await _wait_for(lambda: stream.q.qsize() == 0)
        assert dialer.sockets[1].sent[1:] == [
            json.dumps(
                {
                    "type": "participant",
                    "action": "join",
                    "participant": {"id": "p1", "name": "Alice", "tag": 3},
                }
            )
        ]
        await stream.close()

    with redirect_stdout(buf):
        _with_dialer(dialer, drive)
    out = buf.getvalue()
    assert "WARNING" in out and "perStream=False" in out, out
    print("OK a reconnect honours the new grant and drops audio in the old shape")


def test_exhausted_retries_report_the_failure():
    # First dial succeeds, every later one is refused.
    dialer = _Dialer(fail_after=2)
    reasons = []
    buf = io.StringIO()

    async def drive():
        stream = _fast_stream(per_stream=True)
        stream.reconnect_retries = 2
        stream.on_failure = lambda reason: reasons.append(reason)
        task = asyncio.create_task(stream.connect())
        assert await _wait_for(lambda: dialer.sockets)
        dialer.sockets[0].push(_ack_frame(per_stream=True))
        await task
        dialer.sockets[0].end()
        assert await _wait_for(lambda: reasons, timeout=3.0), "on_failure never fired"
        assert dialer.attempts == 3, dialer.attempts  # 1 initial + 2 retries
        assert stream.ready is False
        await stream.close()

    with redirect_stdout(buf):
        _with_dialer(dialer, drive)
    assert reasons == ["transcriber-unreachable"], reasons
    print("OK exhausted reconnect retries surface a bot-error reason")


def test_error_reply_fails_the_handshake_immediately():
    dialer = _Dialer()
    buf = io.StringIO()

    async def drive():
        # A 30 s watchdog: if the {type:'error'} were ignored this would block on it.
        stream = _fast_stream(per_stream=True, ack_timeout=30)
        task = asyncio.create_task(stream.connect())
        assert await _wait_for(lambda: dialer.sockets)
        dialer.sockets[0].push(
            json.dumps({"type": "error", "message": "Invalid sample rate: 8000."})
        )
        started = time.monotonic()
        try:
            await task
        except RuntimeError as e:
            elapsed = time.monotonic() - started
            await stream.close()
            return str(e), elapsed
        await stream.close()
        raise AssertionError("a rejected init must fail connect()")

    with redirect_stdout(buf):
        message, elapsed = _with_dialer(dialer, drive)
    assert "Invalid sample rate" in message, message
    assert elapsed < 5, f"the error reply must not wait out the ack watchdog ({elapsed}s)"
    print("OK a {type:'error'} handshake reply fails connect() at once")


# --- bounded send queue ------------------------------------------------------
def _bounded_stream(maxsize):
    saved = os.environ.get("VISIOBOT_WS_MAX_QUEUE_FRAMES")
    os.environ["VISIOBOT_WS_MAX_QUEUE_FRAMES"] = str(maxsize)
    try:
        return TranscriberStream("ws://transcriber", per_stream=True)
    finally:
        if saved is None:
            os.environ.pop("VISIOBOT_WS_MAX_QUEUE_FRAMES", None)
        else:
            os.environ["VISIOBOT_WS_MAX_QUEUE_FRAMES"] = saved


def test_send_queue_is_bounded_and_sheds_mixed_first():
    stream = _bounded_stream(4)
    buf = io.StringIO()
    with redirect_stdout(buf):
        stream.send_participant("join", "p1", "Alice", 1)  # control
        stream.enqueue_tagged(1, 0, b"t0")
        stream.enqueue_mixed(0, b"m0")
        stream.enqueue_tagged(1, 1, b"t1")
        assert stream.q.qsize() == 4
        # Full: the next put sheds the oldest MIXED frame first.
        stream.enqueue_tagged(1, 2, b"t2")
        frames = [stream.q.get_nowait() for _ in range(stream.q.qsize())]

    assert len(frames) == 4
    assert stream.q.dropped == 1
    magics = [f[0] for f in frames if isinstance(f, (bytes, bytearray))]
    assert ts_mod.MAGIC_MIXED not in magics, "the mixed archive frame must go first"
    assert isinstance(frames[0], str), "control frames are never dropped"
    print("OK the send queue is bounded and drops mixed recording frames first")


def test_control_frames_are_never_dropped():
    stream = _bounded_stream(2)
    buf = io.StringIO()
    with redirect_stdout(buf):
        stream.send_participant("join", "p1", "Alice", 1)
        stream.send_participant("join", "p2", "Bob", 2)
        # Queue is full of control: an audio frame does not evict them.
        stream.enqueue_tagged(1, 0, b"t0")
        stream.enqueue_tagged(1, 1, b"t1")
        frames = [stream.q.get_nowait() for _ in range(stream.q.qsize())]

    controls = [f for f in frames if isinstance(f, str)]
    assert len(controls) == 2, frames
    assert stream.q.dropped == 1, "only the older AUDIO frame may be shed"
    print("OK control frames survive a full queue; only audio is shed")


def test_drops_are_logged_once_not_per_frame():
    stream = _bounded_stream(2)
    buf = io.StringIO()
    with redirect_stdout(buf):
        for i in range(12):
            stream.enqueue_tagged(1, i, b"pcm")
    out = buf.getvalue()
    assert stream.q.dropped == 10, stream.q.dropped
    assert out.count("send queue full") == 1, out
    assert "WARNING" in out
    print("OK queue overflow is logged once, not once per dropped frame")


# --- wire contract -----------------------------------------------------------
def test_init_advertises_the_mixed_recording_capability():
    stream = TranscriberStream("ws://t", diarization_mode="native", per_stream=True)
    ws = FakeWs()
    stream.ws = ws
    asyncio.run(stream._send_init())
    init = json.loads(ws.sent[0])
    assert init["mixedRecording"] is True, "the capability is advertised in init"
    assert init["perStream"] is True
    print("OK the init frame advertises the mixedRecording capability")


def test_mixed_recording_comes_from_the_ack_only():
    stream = TranscriberStream("ws://t", per_stream=True)
    assert stream.mixed_recording is False
    buf = io.StringIO()
    with redirect_stdout(buf):
        # Advertising the capability never grants it: an ack without the key means no.
        stream._on_ack({"type": "ack", "perStream": True})
        assert stream.mixed_recording is False, "the request must never grant it"
        stream._on_ack({"type": "ack", "perStream": True, "mixedRecording": True})
    assert stream.mixed_recording is True
    print("OK mixed_recording is read from the ack GRANT, never from our request")


def test_mode_change_hook_sees_only_transitions():
    stream = TranscriberStream("ws://t", per_stream=True)
    seen = []
    stream.on_mode_change = seen.append
    buf = io.StringIO()
    with redirect_stdout(buf):
        stream._on_ack({"type": "ack", "perStream": True})
        stream._on_ack({"type": "ack", "perStream": True})  # re-ack, same grant
        stream._on_ack({"type": "ack", "perStream": False})  # downgraded
    assert seen == [True, False], seen
    print("OK on_mode_change fires only on a real effective-mode transition")


def test_a_reconnect_that_demotes_the_grant_reaches_the_mode_hook():
    """The ACK is the authority on the mode.

    A link loss clears the effective mode and notifies, but the owner discards
    that call (the producer must keep the granted wire shape across the gap).
    Recording it as the notified state made the reconnect's perStream=false ack
    look unchanged, so the hook never fired: the mixer was never realigned and the
    bot went on shipping tagged/0x02 frames into a Transcriber back on the legacy
    path, which forwards the whole message verbatim as PCM."""
    seen = []
    buf = io.StringIO()

    async def drive():
        stream = _fast_stream(per_stream=True)
        stream.on_mode_change = seen.append
        stream._on_ack({"type": "ack", "perStream": True})
        # The socket dies: per_stream is cleared and the loss is SIGNALLED...
        stream._supervised = True
        stream.ws = None
        stream._on_socket_closed(None)
        # ...then the replacement instance grants the legacy mixed path.
        stream._on_ack({"type": "ack", "perStream": False})
        await stream.close()

    with redirect_stdout(buf):
        asyncio.run(drive())
    assert seen == [True, False, False], seen
    assert seen[-1] is False, "the demoting re-ack must reach the hook"
    print("OK a reconnect that demotes the grant still notifies the producer")


def test_a_regrant_that_only_flips_mixed_recording_reaches_the_hook():
    """mixedRecording is the OTHER negotiated axis: a re-grant that keeps
    perStream but revokes/grants the archive flow moves the mixer's role too
    (idle <-> recording), so the dedup may not compare perStream alone."""
    stream = TranscriberStream("ws://t", per_stream=True)
    seen = []
    stream.on_mode_change = seen.append
    buf = io.StringIO()
    with redirect_stdout(buf):
        stream._on_ack({"type": "ack", "perStream": True, "mixedRecording": False})
        stream._on_ack({"type": "ack", "perStream": True, "mixedRecording": True})
        # Same grant on BOTH axes: still silent.
        stream._on_ack({"type": "ack", "perStream": True, "mixedRecording": True})
    assert seen == [True, True], seen
    assert stream.mixed_recording is True
    print("OK a mixedRecording-only re-grant reaches the mode hook")


def test_a_socket_closed_during_the_handshake_fails_connect_fast():
    """A socket that dies mid-handshake used to burn the whole ACK_TIMEOUT_S: the
    close handler returned without releasing the watchdog, so connect() sat on an
    ack that could never arrive — delaying the join-failed bot-error (and the
    Scheduler's re-route) by up to 10 s per failed dial."""
    dialer = _Dialer()
    buf = io.StringIO()

    async def drive():
        # A 30 s watchdog: burning it would blow the test's own timeout budget.
        stream = _fast_stream(per_stream=True, ack_timeout=30)
        task = asyncio.create_task(stream.connect())
        assert await _wait_for(lambda: dialer.sockets)
        started = time.monotonic()
        dialer.sockets[0].end()  # the peer hangs up before acking
        try:
            await task
        except RuntimeError as e:
            elapsed = time.monotonic() - started
            await stream.close()
            return str(e), elapsed
        await stream.close()
        raise AssertionError("a handshake that can never complete must fail connect()")

    with redirect_stdout(buf):
        message, elapsed = _with_dialer(dialer, drive)
    assert "socket closed before the ack" in message, message
    assert elapsed < 5, f"connect() burned the ack watchdog ({elapsed}s)"
    assert dialer.attempts == 1, "a handshake that never completed must not redial"
    print("OK a socket that dies mid-handshake fails connect() at once")


def test_enqueue_mixed_uses_magic_2_and_tag_0():
    stream = TranscriberStream("ws://t")
    stream.enqueue_mixed(0x01020304, b"\xaa\xbb")
    stream.enqueue_tagged(7, 0x01020304, b"\xcc\xdd")
    mixed = stream.q.get_nowait()
    tagged = stream.q.get_nowait()

    assert mixed[0] == ts_mod.MAGIC_MIXED == 0x02
    assert mixed[1] == 0, "the mixed flow carries tag 0 always"
    assert mixed[2:4] == b"\x00\x00"
    assert mixed[4:8] == (0x01020304).to_bytes(4, "little")
    assert mixed[8:] == b"\xaa\xbb"
    # Same builder, same header layout, only MAGIC and tag differ.
    assert tagged[0] == ts_mod.MAGIC_TAGGED == 0x01
    assert tagged[1] == 7
    assert tagged[2:] == mixed[2:4] + mixed[4:8] + b"\xcc\xdd"
    # Neither magic can be mistaken for a JSON control frame.
    assert mixed[0] != 0x7B and tagged[0] != 0x7B
    print("OK enqueue_mixed emits MAGIC 0x02 / tag 0 through the shared builder")


_TESTS = [
    test_peer_close_clears_state_and_reconnects,
    test_reconnect_honours_the_new_grant_and_drops_stale_audio,
    test_exhausted_retries_report_the_failure,
    test_error_reply_fails_the_handshake_immediately,
    test_send_queue_is_bounded_and_sheds_mixed_first,
    test_control_frames_are_never_dropped,
    test_drops_are_logged_once_not_per_frame,
    test_init_advertises_the_mixed_recording_capability,
    test_mixed_recording_comes_from_the_ack_only,
    test_mode_change_hook_sees_only_transitions,
    test_a_reconnect_that_demotes_the_grant_reaches_the_mode_hook,
    test_a_regrant_that_only_flips_mixed_recording_reaches_the_hook,
    test_a_socket_closed_during_the_handshake_fails_connect_fast,
    test_enqueue_mixed_uses_magic_2_and_tag_0,
]


def main():
    for t in _TESTS:
        t()
    print(f"\nALL {len(_TESTS)} TESTS PASSED")


if __name__ == "__main__":
    main()
