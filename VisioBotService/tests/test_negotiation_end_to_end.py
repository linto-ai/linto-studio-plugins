"""End-to-end negotiation: a REAL LiveKitBot, a REAL TranscriberStream and a
REAL AudioMixer over a fake socket, so the handshake GRANT is followed all the
way to the bytes on the wire.

The sibling suites test the two halves apart (tests/test_dual_flow.py drives the
mixer role with a fake transcriber, tests/test_transcriber_lifecycle.py drives the
wire with no bot). What only shows up when they are wired together:

  - FAIL-CLOSED DEMOTION: the bot advertises perStream + the mixedRecording
    capability, the Transcriber acks perStream:false (it archives this channel and
    the bot could not supply the mixed flow, or per-stream is off there). The bot
    must then run the LEGACY mixed path — mixer started, diarization ON, bare
    header-less PCM on the wire — and say so loudly on both sides;
  - GRANT: perStream + mixedRecording acked ⇒ the mixer becomes the ARCHIVE flow
    (diarization OFF) and the socket carries BOTH magics: 0x02 tag 0 for the
    archive and 0x01 <tag> for the speech, each with the meeting clock;
  - the screen-share gate holds in per-stream mode too (it is decided before the
    mode is ever consulted, but that is exactly the kind of thing a refactor
    silently moves);
  - the RECONNECT window, which is routine in production (pod restart, LB
    re-route; no affinity across reconnects): the re-run init re-announces the
    live roster with its tags, a rename landing inside the gap is not lost, and a
    reconnect that DEMOTES the grant moves the producer back to the legacy bare
    mixed PCM instead of streaming framed audio at a Transcriber that no longer
    parses it.

Run:  python3 VisioBotService/tests/test_negotiation_end_to_end.py
(or via pytest:  pytest VisioBotService/tests/test_negotiation_end_to_end.py)
"""
import asyncio
import io
import json
import os
import struct
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


_EOF = object()


# --- the LiveKit room double, installed as rtc.Room ---------------------------
class _FakeRoom:
    def __init__(self):
        self.name = "room-1"
        self.handlers = {}
        self.remote_participants = {}
        self.connected = False
        self.disconnected = False
        self.local_participant = types.SimpleNamespace(identity="linto-bot")

    def on(self, event, handler):
        self.handlers[event] = handler

    async def connect(self, url, token, options=None):
        self.connected = True

    async def disconnect(self):
        self.disconnected = True


class _FakeAudioStream:
    """rtc.AudioStream double: yields the frames `_frames` holds, then ends."""

    frames: list = []

    def __init__(self, track, sample_rate=None, num_channels=None):
        self._frames = list(_FakeAudioStream.frames)

    def __aiter__(self):
        async def gen():
            for pcm in self._frames:
                yield types.SimpleNamespace(frame=types.SimpleNamespace(data=pcm))

        return gen()

    async def aclose(self):
        pass


_TRACK_KIND = types.SimpleNamespace(KIND_AUDIO="audio", KIND_VIDEO="video")
_TRACK_SOURCE = types.SimpleNamespace(
    SOURCE_UNKNOWN=0,
    SOURCE_CAMERA=1,
    SOURCE_MICROPHONE=2,
    SOURCE_SCREENSHARE=3,
    SOURCE_SCREENSHARE_AUDIO=4,
)

_lk = _stub("livekit")
_rtc = _stub(
    "livekit.rtc",
    Room=_FakeRoom,
    AudioStream=_FakeAudioStream,
    TrackKind=_TRACK_KIND,
    TrackSource=_TRACK_SOURCE,
    RoomOptions=lambda **kwargs: kwargs,
    Transcription=object,
    TranscriptionSegment=object,
)
_lk.rtc = _rtc
_stub("livekit.api", AccessToken=object, VideoGrants=object)
_stub("websockets", connect=None)

import bot.livekit_bot as livekit_bot_mod  # noqa: E402
import bot.transcriber_stream as ts_mod  # noqa: E402
from bot.audio_mixer import FRAME_SAMPLES  # noqa: E402
from bot.livekit_bot import LiveKitBot  # noqa: E402

_RTC_DOUBLES = {
    "Room": _FakeRoom,
    "AudioStream": _FakeAudioStream,
    "TrackKind": _TRACK_KIND,
    "TrackSource": _TRACK_SOURCE,
    "RoomOptions": lambda **kwargs: kwargs,
}


# --- the transcriber socket double -------------------------------------------
class FakeWs:
    def __init__(self, ack=None):
        self.sent = []
        self.closed = False
        self._inbox: asyncio.Queue = asyncio.Queue()
        if ack is not None:
            self._inbox.put_nowait(ack)  # the ack waits for the recv loop to start

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

    async def close(self):
        self.closed = True
        self._inbox.put_nowait(_EOF)

    def push(self, message):
        self._inbox.put_nowait(message)

    def end(self):
        """The peer hung up: the async-for ends, exactly like `websockets` does."""
        self._inbox.put_nowait(_EOF)

    # helpers
    def binaries(self):
        return [f for f in self.sent if isinstance(f, (bytes, bytearray))]

    def controls(self):
        return [json.loads(f) for f in self.sent if isinstance(f, str)]


class _Dialer:
    def __init__(self, ack):
        self.ack = ack
        self.sockets = []

    async def __call__(self, url, **kwargs):
        ws = FakeWs(self.ack)
        self.sockets.append(ws)
        return ws


class _ReconnectDialer:
    """Hands out one FakeWs per dial with NO ack pre-queued, so the test decides
    exactly when each handshake completes and the reconnect GAP stays open for as
    long as it needs (a real reconnect lands in single-digit milliseconds here)."""

    def __init__(self):
        self.sockets = []

    async def __call__(self, url, **kwargs):
        ws = FakeWs()
        self.sockets.append(ws)
        return ws


def _ack(per_stream, mixed_recording):
    return json.dumps(
        {
            "type": "ack",
            "message": "Init done",
            "perStream": per_stream,
            "mixedRecording": mixed_recording,
        }
    )


class _Pub:
    def __init__(self, source, track=None):
        self.source = source
        self.track = track


class _Track:
    def __init__(self, sid, kind=_TRACK_KIND.KIND_AUDIO):
        self.sid = sid
        self.kind = kind


def _tone(value, samples=FRAME_SAMPLES):
    return struct.pack(f"<{samples}h", *([value] * samples))


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


def _make_bot():
    """A bot that REQUESTS per-stream, with the VAD hangover off so a silent frame
    is really silent for the test (the hangover has its own coverage)."""
    saved = {
        k: os.environ.get(k) for k in ("BOT_PERSTREAM", "BOT_VAD_HANGOVER_MS")
    }
    os.environ["BOT_PERSTREAM"] = "true"
    os.environ["BOT_VAD_HANGOVER_MS"] = "0"
    try:
        return LiveKitBot(
            livekit_url="wss://lk.example.org",
            room_name="room-1",
            websocket_url="ws://transcriber/ws/S1,0",
            bot_id=7,
            join_token="a.join.token",
        )
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def _run(dialer, coro_factory):
    """Run `coro_factory()` against our sockets AND our rtc doubles.

    The whole suite shares one process and every test module stubs `livekit`, so
    whichever stub was imported first wins: patch the module object
    bot.livekit_bot actually holds (and put it back afterwards, since this file
    replaces rtc.Room itself, not only an enum).
    """
    saved_ws = ts_mod.websockets
    saved_rtc = {k: getattr(livekit_bot_mod.rtc, k, None) for k in _RTC_DOUBLES}
    ts_mod.websockets = types.SimpleNamespace(connect=dialer)
    for key, value in _RTC_DOUBLES.items():
        setattr(livekit_bot_mod.rtc, key, value)
    try:
        return asyncio.run(coro_factory())
    finally:
        ts_mod.websockets = saved_ws
        for key, value in saved_rtc.items():
            setattr(livekit_bot_mod.rtc, key, value)


# --- fail-closed demotion -----------------------------------------------------
def test_a_demoted_bot_runs_the_legacy_mixed_path():
    dialer = _Dialer(_ack(per_stream=False, mixed_recording=False))
    buf = io.StringIO()

    async def drive():
        bot = _make_bot()
        assert bot.requested_per_stream is True
        assert await bot.start() is True

        # The init advertised the request AND the capability...
        init = dialer.sockets[0].controls()[0]
        assert init["type"] == "init"
        assert init["perStream"] is True
        assert init["mixedRecording"] is True
        # ...but the GRANT is what runs: the legacy mixed path, untouched.
        assert bot.transcriber.per_stream is False
        assert bot.transcriber.mixed_recording is False
        assert bot._mixer_role == "mixed"
        assert bot.mixer.diarization is True, "the mixed path needs its energy VAD"
        assert bot.mixer._running is True

        # And the wire shape is the legacy one: bare, header-less PCM.
        bot._on_mixed_frame(b"\x11\x22")
        assert await _wait_for(lambda: b"\x11\x22" in dialer.sockets[0].sent)

        await bot.dispose()
        return bot

    with redirect_stdout(buf):
        bot = _run(dialer, drive)

    out = buf.getvalue()
    assert "WARNING" in out and "MIXED" in out, out
    assert bot.room.disconnected is True, "dispose must leave the room"
    assert dialer.sockets[0].closed is True, "dispose must close the transcriber WS"
    assert bot.mixer._running is False
    print("ok: a perStream:false ack demotes the bot to the legacy mixed path")


# --- the granted dual flow ----------------------------------------------------
def test_the_granted_dual_flow_carries_both_magics():
    dialer = _Dialer(_ack(per_stream=True, mixed_recording=True))
    buf = io.StringIO()
    loud, quiet = _tone(5000), _tone(1)

    async def drive():
        bot = _make_bot()
        assert await bot.start() is True
        assert bot.transcriber.per_stream is True
        assert bot.transcriber.mixed_recording is True
        assert bot._mixer_role == "recording"
        assert bot.mixer.diarization is False, "the archive must not pay for the RMS pass"

        bot._participants["alice"] = "Alice"
        # Record what reaches the mixer (its own tick drains the buffers).
        pushed = []
        real_push = bot.mixer.push
        bot.mixer.push = lambda ident, pcm, name=None: (
            pushed.append((ident, pcm)),
            real_push(ident, pcm, name),
        )[1]
        _FakeAudioStream.frames = [loud, quiet, loud]
        await bot._pump(_Track("TR_1"), "alice")
        # The archive gets EVERY frame (keepAudio records the silence too).
        assert [pcm for _, pcm in pushed] == [loud, quiet, loud]
        # One archive frame, produced by the mixer tick, on the same socket.
        bot._on_mixed_frame(b"\xaa\xbb")
        assert await _wait_for(
            lambda: any(
                f[0] == ts_mod.MAGIC_MIXED for f in dialer.sockets[0].binaries()
            )
        )
        assert await _wait_for(
            lambda: len(
                [f for f in dialer.sockets[0].binaries() if f[0] == ts_mod.MAGIC_TAGGED]
            )
            == 2
        )
        frames = list(dialer.sockets[0].binaries())
        await bot.dispose()
        return frames

    with redirect_stdout(buf):
        frames = _run(dialer, drive)

    tagged = [f for f in frames if f[0] == ts_mod.MAGIC_TAGGED]
    mixed = [f for f in frames if f[0] == ts_mod.MAGIC_MIXED]
    # Only the VAD-active frames are transcribed; the silent one is not.
    assert [bytes(f[8:]) for f in tagged] == [loud, loud]
    assert {f[1] for f in tagged} == {0}, "alice holds the first tag"
    assert mixed, "the archive flow must reach the wire"
    for frame in mixed:
        assert frame[1] == 0, "the mixed flow is always tag 0"
    for frame in tagged + mixed:
        assert frame[2:4] == b"\x00\x00", "reserved u16 stays 0"
        # The meeting clock is a plain u32 LE, and this bot has just started.
        assert 0 <= int.from_bytes(frame[4:8], "little") < 60_000
    print("ok: the granted dual flow ships 0x01 speech and 0x02 archive frames")


def test_the_screen_share_gate_holds_in_per_stream_mode():
    dialer = _Dialer(_ack(per_stream=True, mixed_recording=True))
    buf = io.StringIO()

    async def drive():
        bot = _make_bot()
        assert await bot.start() is True
        started = []
        bot._start_pump = lambda track, identity: started.append((track.sid, identity))
        part = types.SimpleNamespace(identity="alice", name="Alice")
        share = _Track("TR_share")
        mic = _Track("TR_mic")
        bot._on_track_subscribed(share, _Pub(_TRACK_SOURCE.SOURCE_SCREENSHARE_AUDIO, share), part)
        bot._on_track_subscribed(mic, _Pub(_TRACK_SOURCE.SOURCE_MICROPHONE, mic), part)
        await bot.dispose()
        return started

    with redirect_stdout(buf):
        started = _run(dialer, drive)
    assert started == [("TR_mic", "alice")], started
    print("ok: per-stream pumps the microphone track only, never the shared tab")


# --- the reconnect window -----------------------------------------------------
def _participant(identity, name):
    return types.SimpleNamespace(identity=identity, name=name)


async def _start_acked(dialer, ack):
    """Build a bot, dial, and complete the first handshake with `ack`."""
    bot = _make_bot()
    bot.transcriber.reconnect_base_ms = 1
    task = asyncio.create_task(bot.start())
    assert await _wait_for(lambda: dialer.sockets), "the bot never dialed"
    dialer.sockets[0].push(ack)
    assert await task is True
    return bot


def test_a_reconnect_reannounces_the_live_roster():
    """The Transcriber rebuilds its tag -> participant map from scratch out of
    every init frame (WebsocketServer handleInitMessage), and the init is re-run
    on every reconnect — which is routine (pod restart, LB re-route; there is no
    affinity across reconnects). Sending an empty roster there left the map empty:
    every sub-ASR lazily created afterwards got participantId/participantName
    null, so every later caption carried locutor null and the in-room overlay
    dropped it. Nothing else re-announces the roster (_register_participant
    early-returns for a known identity, and LiveKit fires no new join events)."""
    dialer = _ReconnectDialer()
    buf = io.StringIO()

    async def drive():
        bot = await _start_acked(dialer, _ack(per_stream=True, mixed_recording=True))
        # The FIRST init is empty: the room is joined only after the handshake.
        assert dialer.sockets[0].controls()[0]["participants"] == []

        bot._on_participant_connected(_participant("alice", "Alice"))
        bot._on_participant_connected(_participant("bob", "Bob"))

        # The Transcriber pod goes away.
        dialer.sockets[0].end()
        assert await _wait_for(lambda: len(dialer.sockets) > 1), "no reconnect"
        dialer.sockets[1].push(_ack(per_stream=True, mixed_recording=True))
        assert await _wait_for(lambda: bot.transcriber.ready is True)
        init = dialer.sockets[1].controls()[0]
        await bot.dispose()
        return init

    with redirect_stdout(buf):
        init = _run(dialer, drive)

    assert init["type"] == "init" and init["perStream"] is True
    assert init["participants"] == [
        {"id": "alice", "name": "Alice", "tag": 0},
        {"id": "bob", "name": "Bob", "tag": 1},
    ], init["participants"]
    print("ok: the reconnect's init re-announces the live roster with its tags")


def test_a_rename_inside_the_reconnect_gap_reaches_the_new_transcriber():
    """`transcriber.per_stream` is a LINK-state flag, cleared for the whole
    reconnect window. Gating the 'rename' control frame on it dropped every rename
    landing in that gap — and it is never retried, because the new name is already
    recorded so each later identical event early-returns. The sub-ASR then kept
    the stale display name for the rest of the call. Gating on the latched mixer
    ROLE instead keeps the frame, which the bounded queue never drops (control)
    and the writer flushes as soon as the replacement link is ack'd."""
    dialer = _ReconnectDialer()
    buf = io.StringIO()

    async def drive():
        bot = await _start_acked(dialer, _ack(per_stream=True, mixed_recording=True))
        bot._on_participant_connected(_participant("alice", "Alice"))
        assert bot._tags["alice"] == 0

        dialer.sockets[0].end()
        assert await _wait_for(lambda: bot.transcriber.per_stream is False)
        assert await _wait_for(lambda: len(dialer.sockets) > 1), "no reconnect"
        # Still inside the gap: the replacement socket has not been ack'd yet.
        assert bot.transcriber.per_stream is False
        assert bot._mixer_role == "recording", "the latched role survives the gap"
        bot._on_participant_name_changed(_participant("alice", "Alice (host)"))

        # The link comes back and the writer flushes what it buffered.
        dialer.sockets[1].push(_ack(per_stream=True, mixed_recording=True))
        assert await _wait_for(lambda: bot.transcriber.ready is True)
        assert await _wait_for(
            lambda: any(
                c.get("type") == "participant" and c.get("action") == "rename"
                for c in dialer.sockets[1].controls()
            )
        ), dialer.sockets[1].controls()
        controls = dialer.sockets[1].controls()
        await bot.dispose()
        return controls

    with redirect_stdout(buf):
        controls = _run(dialer, drive)

    renames = [c for c in controls if c.get("action") == "rename"]
    assert renames == [
        {
            "type": "participant",
            "action": "rename",
            "participant": {"id": "alice", "name": "Alice (host)", "tag": 0},
        }
    ], renames
    print("ok: a rename inside the reconnect gap still reaches the Transcriber")


def test_a_reconnect_that_demotes_the_grant_switches_the_wire_shape():
    """The replacement instance may not run TRANSCRIBER_PERSTREAM_DIARIZATION (or
    may demote a keepAudio channel), so it acks perStream:false. The bot must move
    back to the LEGACY mixed path: mixer restarted with diarization ON and bare,
    header-less PCM on the wire. Suppressing that notification (because the link
    loss had already recorded per_stream=False) left the producer emitting 0x01 /
    0x02 framed audio into a Transcriber that forwards the whole message verbatim
    as PCM — garbage audio and no usable captions for the rest of the call."""
    dialer = _ReconnectDialer()
    buf = io.StringIO()

    async def drive():
        bot = await _start_acked(dialer, _ack(per_stream=True, mixed_recording=True))
        assert bot._mixer_role == "recording"

        dialer.sockets[0].end()
        assert await _wait_for(lambda: len(dialer.sockets) > 1), "no reconnect"
        dialer.sockets[1].push(_ack(per_stream=False, mixed_recording=False))
        assert await _wait_for(lambda: bot.transcriber.ready is True)

        assert bot._mixer_role == "mixed", "the demoting ack must realign the mixer"
        assert bot.mixer.diarization is True, "the mixed path needs its energy VAD"
        bot._on_mixed_frame(b"\x11\x22")
        assert await _wait_for(lambda: b"\x11\x22" in dialer.sockets[1].sent)
        binaries = list(dialer.sockets[1].binaries())
        await bot.dispose()
        return binaries

    with redirect_stdout(buf):
        binaries = _run(dialer, drive)

    assert binaries == [b"\x11\x22"], binaries
    assert all(f[0] not in (ts_mod.MAGIC_TAGGED, ts_mod.MAGIC_MIXED) for f in binaries)
    print("ok: a demoting reconnect moves the producer back to bare mixed PCM")


_TESTS = [
    test_a_demoted_bot_runs_the_legacy_mixed_path,
    test_the_granted_dual_flow_carries_both_magics,
    test_the_screen_share_gate_holds_in_per_stream_mode,
    test_a_reconnect_reannounces_the_live_roster,
    test_a_rename_inside_the_reconnect_gap_reaches_the_new_transcriber,
    test_a_reconnect_that_demotes_the_grant_switches_the_wire_shape,
]


def main():
    for t in _TESTS:
        t()
    print(f"\nALL {len(_TESTS)} TESTS PASSED")


if __name__ == "__main__":
    main()
