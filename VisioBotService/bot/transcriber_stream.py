"""TranscriberStream — Python port of BotService/bot/TranscriberStream.js.

Bridges one bot's mixed audio to one LinTO Transcriber over the existing WS
ingest protocol:

  - on connect, send the `init` frame (encoding/sampleRate/diarizationMode +
    participants list), then HOLD audio until the Transcriber replies
    `{type:'ack'}` (ACK-gating). Buffered frames are flushed on the ack.
  - audio frames are binary PCM s16le; control messages (participant join/leave)
    are JSON and are NOT ack-gated.
  - all sends go through a SINGLE writer coroutine reading from one asyncio.Queue
    (preserves order; never one task per frame).
"""
import asyncio
import collections
import json

import websockets

MAX_BUFFER = 500
ACK_TIMEOUT_S = 10


class TranscriberStream:
    def __init__(
        self,
        url: str,
        participants_provider=None,
        diarization_mode: str = "asr",
        max_buffer: int = MAX_BUFFER,
        ack_timeout: float = ACK_TIMEOUT_S,
        per_stream: bool = False,
    ) -> None:
        self.url = url
        self.participants_provider = participants_provider
        self.diarization_mode = diarization_mode
        self.ack_timeout = ack_timeout

        # perStream (PHASE 3): `requested_per_stream` is what we advertise in the
        # init frame; `per_stream` is the EFFECTIVE mode, set only once the
        # Transcriber acks back `perStream:true` (D9 — honour the ACK). Until the
        # ack arrives it stays False, so the legacy mixed path is the default.
        self.requested_per_stream = per_stream
        self.per_stream = False

        self.ws = None
        self.ready = False
        self._closed = False

        # One queue, one writer. Pre-ack audio is buffered (bounded, drop-oldest)
        # in a deque until the ack flushes it into the queue.
        self.q: asyncio.Queue = asyncio.Queue()
        self.buffer: collections.deque = collections.deque(maxlen=max_buffer)

        self._recv_task: asyncio.Task | None = None
        self._writer_task: asyncio.Task | None = None
        self._ack_event = asyncio.Event()

    async def connect(self) -> None:
        """Open the socket, send init, and wait (watchdog) for the ack."""
        self.ws = await websockets.connect(self.url, max_size=None)
        await self._send_init()
        self._recv_task = asyncio.create_task(self._recv())
        self._writer_task = asyncio.create_task(self._writer())
        try:
            await asyncio.wait_for(self._ack_event.wait(), timeout=self.ack_timeout)
        except asyncio.TimeoutError as e:
            raise RuntimeError(
                f"TranscriberStream: no ack within {self.ack_timeout}s"
            ) from e

    async def _send_init(self) -> None:
        participants = (
            self.participants_provider() if self.participants_provider else []
        )
        await self.ws.send(
            json.dumps(
                {
                    "type": "init",
                    "encoding": "pcm",
                    "sampleRate": 16000,
                    "diarizationMode": self.diarization_mode,
                    "perStream": self.requested_per_stream,
                    "participants": participants,
                }
            )
        )

    async def _recv(self) -> None:
        try:
            async for message in self.ws:
                if isinstance(message, (bytes, bytearray)):
                    continue
                try:
                    obj = json.loads(message)
                except Exception:  # noqa: BLE001
                    continue
                if obj.get("type") == "ack":
                    if not self.ready:
                        # Honour the negotiated ACK (D9): the effective mode is
                        # whatever the Transcriber grants, NOT what we requested.
                        # Resolve it BEFORE flushing buffered frames so the very
                        # first frame is already routed correctly.
                        self.per_stream = bool(obj.get("perStream"))
                        self.ready = True
                        self._flush()
                    self._ack_event.set()
        except Exception:  # noqa: BLE001
            pass

    async def _writer(self) -> None:
        try:
            while True:
                frame = await self.q.get()
                if self.ws is None or self._closed:
                    break
                await self.ws.send(frame)
        except asyncio.CancelledError:
            pass
        except Exception:  # noqa: BLE001
            pass

    def _flush(self) -> None:
        while self.buffer:
            self.q.put_nowait(self.buffer.popleft())

    def enqueue(self, frame_bytes: bytes) -> None:
        """Queue one binary PCM frame. Pre-ack frames buffer (drop-oldest)."""
        if self._closed:
            return
        if self.ready:
            self.q.put_nowait(frame_bytes)
        else:
            # deque(maxlen) drops the oldest automatically when full.
            self.buffer.append(frame_bytes)

    def enqueue_tagged(self, tag: int, t_ms: int, pcm: bytes) -> None:
        """Queue one per-stream tagged audio frame (PHASE 3).

        Wire format — 8-byte binary header then raw PCM:
          byte 0      MAGIC = 0x01      (never 0x7B '{', so it can't collide with
                                         a JSON control message)
          byte 1      tag u8            (stable per participant identity)
          bytes 2-3   reserved u16 = 0  (keeps the PCM 16-bit aligned)
          bytes 4-7   meetingTimeMs u32 little-endian (bot-relative clock)
          bytes 8..   PCM s16le mono 16 kHz (the exact bytes of ev.frame.data)

        Reuses the existing single-writer queue + ACK-gating via enqueue().
        """
        header = bytes([0x01, tag & 0xFF, 0, 0]) + (t_ms & 0xFFFFFFFF).to_bytes(
            4, "little"
        )
        self.enqueue(header + pcm)

    def send_speaker_change(self, position: int, speaker: dict | None) -> None:
        """Forward a native-diarization speaker transition. Mirrors the WEB bot's
        `speakerChanged` control message and, like send_participant, is NOT
        ack-gated — it rides the same single-writer queue so order is preserved.

        `speaker` is {"id":…, "name":…} for a new dominant speaker, or None for a
        silence transition. The Transcriber's SpeakerTracker keys captions off
        `speaker.name` (the real display name); `position` is informational."""
        if self._closed:
            return
        try:
            self.q.put_nowait(
                json.dumps(
                    {
                        "type": "speakerChanged",
                        "position": position,
                        "speaker": speaker,
                    }
                )
            )
        except Exception:  # noqa: BLE001
            pass

    def send_participant(self, action: str, pid: str, name: str, tag: int | None = None) -> None:
        """Forward a participant control message (join/leave/rename). Not
        ack-gated: the writer ships it as soon as the socket is up, independent
        of `ready`. Control is infrequent, so routing it through the same queue
        keeps a single writer and preserves order without a task-per-message.

        The `tag` (per-stream u8) is forwarded for EVERY action when provided,
        so a mid-call 'rename' lets the Transcriber re-key the live sub-ASR's
        display name. Wire shape (parsed by WebsocketServer as `data.participant`):
        {"type":"participant","action":action,"participant":{"id":pid,"name":name,"tag":tag}}."""
        if self._closed:
            return
        participant = {"id": pid, "name": name}
        if tag is not None:
            participant["tag"] = tag
        try:
            self.q.put_nowait(
                json.dumps(
                    {
                        "type": "participant",
                        "action": action,
                        "participant": participant,
                    }
                )
            )
        except Exception:  # noqa: BLE001
            pass

    async def close(self) -> None:
        self._closed = True
        for task in (self._recv_task, self._writer_task):
            if task is not None:
                task.cancel()
        if self.ws is not None:
            try:
                await self.ws.close()
            except Exception:  # noqa: BLE001
                pass
