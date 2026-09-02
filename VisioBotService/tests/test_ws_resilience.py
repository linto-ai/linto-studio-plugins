"""Standalone tests for the parts of the Transcriber WS resilience (#C1/#C5)
that only show up once the SINGLE WRITER is in the picture:

  - a STALLED writer (a slow Transcriber, or a socket whose send never returns)
    is the realistic overflow case: the link is still "up", so nothing clears it
    and nothing reconnects, yet the audio pump keeps producing 50 frames/s per
    participant. Memory must stay flat, the mixed (0x02) archive must be shed
    before the tagged audio, and the drop must be logged a handful of times —
    not once per frame;
  - the writer's put_front() requeue must not be able to push the queue past its
    cap either (a frame handed back to a full queue evicts, it never grows it);
  - the failure report is fired EXACTLY once: after the retries are exhausted the
    stream is dead, and a later close (dispose, a stale socket) must not publish a
    second bot-error nor start another reconnect storm;
  - the ack is re-read in FULL on a reconnect: a replacement Transcriber that
    still grants per-stream but REVOKES mixedRecording (this channel is no longer
    archived from the 0x02 flow) must be honoured on both axes.

The sibling tests/test_transcriber_lifecycle.py covers the close/reconnect/grant
and the queue's own drop policy; this file only adds what needs a live writer.

Run:  python3 VisioBotService/tests/test_ws_resilience.py
(or via pytest:  pytest VisioBotService/tests/test_ws_resilience.py)
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
from bot.transcriber_stream import DROP_WARN_EVERY, TranscriberStream  # noqa: E402


# --- fakes -------------------------------------------------------------------
_EOF = object()


class FakeWs:
    """Async-iterable websocket double. `stalled=True` makes send() park forever
    (a Transcriber that stopped reading), which is what strands the writer."""

    def __init__(self, stalled=False):
        self.sent = []
        self.closed = False
        self.stalled = stalled
        self._inbox: asyncio.Queue = asyncio.Queue()
        self._never = asyncio.Event()

    async def send(self, payload):
        if self.closed:
            raise ConnectionError("FakeWs: socket closed")
        if self.stalled and not isinstance(payload, str):
            # Control/init frames still go through; only the audio stalls, so the
            # handshake completes and the link stays "up".
            await self._never.wait()
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
        self._inbox.put_nowait(_EOF)

    async def close(self):
        self.closed = True
        self._never.set()
        self.end()


class _Dialer:
    def __init__(self, stalled=False, fail_after=None):
        self.sockets = []
        self.attempts = 0
        self.stalled = stalled
        self.fail_after = fail_after  # dial index (1-based) from which to fail

    async def __call__(self, url, **kwargs):
        self.attempts += 1
        if self.fail_after is not None and self.attempts >= self.fail_after:
            raise ConnectionRefusedError("transcriber unreachable")
        ws = FakeWs(stalled=self.stalled)
        self.sockets.append(ws)
        return ws


def _ack_frame(per_stream=True, mixed_recording=False):
    return json.dumps(
        {
            "type": "ack",
            "message": "Init done",
            "perStream": per_stream,
            "mixedRecording": mixed_recording,
        }
    )


async def _settle(times=20):
    for _ in range(times):
        await asyncio.sleep(0)


async def _wait_for(predicate, timeout=2.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        await asyncio.sleep(0.005)
    return False


def _stream(maxsize=None, **kwargs):
    """A stream with a sub-millisecond backoff (fast tests) and, optionally, a
    small queue cap read from the env knob exactly like production does."""
    saved = os.environ.get("VISIOBOT_WS_MAX_QUEUE_FRAMES")
    if maxsize is not None:
        os.environ["VISIOBOT_WS_MAX_QUEUE_FRAMES"] = str(maxsize)
    try:
        stream = TranscriberStream("ws://transcriber", **kwargs)
    finally:
        if maxsize is not None:
            if saved is None:
                os.environ.pop("VISIOBOT_WS_MAX_QUEUE_FRAMES", None)
            else:
                os.environ["VISIOBOT_WS_MAX_QUEUE_FRAMES"] = saved
    stream.reconnect_base_ms = 1
    return stream


def _with_dialer(dialer, coro_factory):
    saved = ts_mod.websockets
    ts_mod.websockets = types.SimpleNamespace(connect=dialer)
    try:
        return asyncio.run(coro_factory())
    finally:
        ts_mod.websockets = saved


# --- a stalled writer ---------------------------------------------------------
def test_a_stalled_writer_cannot_grow_memory():
    """The link is UP but the peer stopped reading: nothing reconnects, nothing
    drains, and the pump keeps producing. This is the case an unbounded
    asyncio.Queue turns into unbounded RSS."""
    dialer = _Dialer(stalled=True)
    buf = io.StringIO()

    async def drive():
        stream = _stream(maxsize=8, per_stream=True)
        task = asyncio.create_task(stream.connect())
        assert await _wait_for(lambda: dialer.sockets)
        dialer.sockets[0].push(_ack_frame(per_stream=True, mixed_recording=True))
        await task
        assert stream.ready is True

        # 1000 archive + 1000 tagged frames into a queue nobody drains.
        for i in range(1000):
            stream.enqueue_mixed(i, b"archive")
            stream.enqueue_tagged(1, i, b"speech")
        await _settle()

        depth = stream.q.qsize()
        dropped = stream.q.dropped
        left = [stream.q.get_nowait() for _ in range(depth)]
        await stream.close()
        return depth, dropped, left

    with redirect_stdout(buf):
        depth, dropped, left = _with_dialer(dialer, drive)

    # At most one frame is held out of the queue by the parked writer.
    assert depth <= 8, f"the queue grew past its cap ({depth} frames)"
    assert dropped >= 2000 - 8 - 1, dropped
    # The archive flow is what gets shed: a shorter recording beats lost captions.
    magics = [f[0] for f in left if isinstance(f, (bytes, bytearray))]
    assert ts_mod.MAGIC_MIXED not in magics, "mixed frames must be shed first"
    out = buf.getvalue()
    lines = out.count("send queue full")
    assert 1 <= lines <= dropped // DROP_WARN_EVERY + 1, (lines, dropped)
    print(f"ok: {dropped} frames dropped behind a stalled writer, {lines} log line(s)")


def test_a_requeued_frame_cannot_push_the_queue_past_its_cap():
    """The writer hands an unsent frame BACK to the head of a queue the producer
    may have filled meanwhile (put_front). That path must evict like any other
    put, never append past the cap."""
    stream = _stream(maxsize=3)
    buf = io.StringIO()
    with redirect_stdout(buf):
        for i in range(3):
            stream.enqueue_tagged(1, i, b"pcm")
        assert stream.q.qsize() == 3
        stream.q.put_front(b"\x01requeued", ts_mod._KIND_AUDIO)
    assert stream.q.qsize() == 3, "put_front must respect the cap"
    assert stream.q.get_nowait() == b"\x01requeued", "and it goes back to the HEAD"
    print("ok: a requeued frame evicts instead of growing the bounded queue")


# --- the failure is reported exactly once -------------------------------------
def test_the_failure_is_reported_exactly_once():
    dialer = _Dialer(fail_after=2)  # the first dial works, every retry is refused
    reasons = []
    buf = io.StringIO()

    async def drive():
        stream = _stream(per_stream=True)
        stream.reconnect_retries = 1
        stream.on_failure = lambda reason: reasons.append(reason)
        task = asyncio.create_task(stream.connect())
        assert await _wait_for(lambda: dialer.sockets)
        dialer.sockets[0].push(_ack_frame(per_stream=True))
        await task
        dialer.sockets[0].end()
        assert await _wait_for(lambda: reasons, timeout=3.0), "on_failure never fired"
        attempts_at_failure = dialer.attempts

        # A dead stream is dead: a later close of the (already abandoned) socket
        # must neither report again nor start another reconnect storm — the owner
        # would otherwise publish a second bot-error for one dead bot.
        stream._on_socket_closed(stream.ws)
        await _settle()
        await asyncio.sleep(0.05)
        await stream.close()
        await _settle()
        return attempts_at_failure

    with redirect_stdout(buf):
        attempts_at_failure = _with_dialer(dialer, drive)

    assert reasons == ["transcriber-unreachable"], reasons
    assert dialer.attempts == attempts_at_failure, "a dead stream must not redial"
    print("ok: an exhausted stream reports its failure exactly once")


def test_a_close_during_the_backoff_stops_the_reconnect_silently():
    """dispose() while the stream is sleeping between retries: the bot is going
    away on purpose, so no failure may be reported (the Scheduler would re-route
    a session that was stopped)."""
    dialer = _Dialer(fail_after=2)
    reasons = []
    buf = io.StringIO()

    async def drive():
        stream = _stream(per_stream=True)
        stream.reconnect_retries = 3
        stream.reconnect_base_ms = 200  # long enough to close mid-backoff
        stream.on_failure = lambda reason: reasons.append(reason)
        task = asyncio.create_task(stream.connect())
        assert await _wait_for(lambda: dialer.sockets)
        dialer.sockets[0].push(_ack_frame(per_stream=True))
        await task
        dialer.sockets[0].end()
        assert await _wait_for(lambda: stream.ready is False)
        await stream.close()
        await asyncio.sleep(0.1)

    with redirect_stdout(buf):
        _with_dialer(dialer, drive)
    assert reasons == [], reasons
    print("ok: an intentional close during the backoff reports no failure")


# --- the whole ack is re-read on a reconnect ----------------------------------
def test_a_reconnect_that_revokes_mixed_recording_is_honoured():
    """The replacement instance still runs per-stream but no longer archives this
    channel. mixedRecording is read from the NEW ack on both axes, otherwise the
    bot keeps paying for (and shipping) an archive flow nobody stores."""
    dialer = _Dialer()
    buf = io.StringIO()

    async def drive():
        stream = _stream(per_stream=True)
        task = asyncio.create_task(stream.connect())
        assert await _wait_for(lambda: dialer.sockets)
        dialer.sockets[0].push(_ack_frame(per_stream=True, mixed_recording=True))
        await task
        assert stream.mixed_recording is True

        dialer.sockets[0].end()
        assert await _wait_for(lambda: len(dialer.sockets) > 1), "no reconnect"
        dialer.sockets[1].push(_ack_frame(per_stream=True, mixed_recording=False))
        assert await _wait_for(lambda: stream.ready is True)
        result = (stream.per_stream, stream.mixed_recording)
        await stream.close()
        return result

    with redirect_stdout(buf):
        per_stream, mixed_recording = _with_dialer(dialer, drive)
    assert per_stream is True, "per-stream is still granted"
    assert mixed_recording is False, "the NEW ack revoked the archive flow"
    print("ok: a reconnect re-reads mixedRecording from the new grant")


_TESTS = [
    test_a_stalled_writer_cannot_grow_memory,
    test_a_requeued_frame_cannot_push_the_queue_past_its_cap,
    test_the_failure_is_reported_exactly_once,
    test_a_close_during_the_backoff_stops_the_reconnect_silently,
    test_a_reconnect_that_revokes_mixed_recording_is_honoured,
]


def main():
    for t in _TESTS:
        t()
    print(f"\nALL {len(_TESTS)} TESTS PASSED")


if __name__ == "__main__":
    main()
