"""TranscriberStream — Python port of BotService/bot/TranscriberStream.js.

Bridges one bot's audio to one LinTO Transcriber over the existing WS ingest
protocol:

  - on connect, send the `init` frame (encoding/sampleRate/diarizationMode, the
    perStream REQUEST and the `mixedRecording` CAPABILITY advertisement), then
    wait for the Transcriber's `{type:'ack'}`, which carries the NEGOTIATED
    perStream / mixedRecording GRANT. connect() only returns once the ack is in,
    and LiveKitBot.start() joins the room strictly after that — so no audio can
    be produced before the ack and none is buffered here (the JS bot's pre-ack
    ring buffer has no equivalent need in this ordering).
  - a `{type:'error'}` reply to the init frame is a REJECTION: it fails the
    handshake at once instead of blindly burning the full ack watchdog.
  - audio frames are binary PCM s16le; control messages (participant
    join/leave/rename, speakerChanged) are JSON.
  - all sends go through a SINGLE writer coroutine reading from one bounded
    queue (preserves order; never one task per frame).

Binary frame layout — 8-byte header, little-endian, then raw PCM s16le mono
16 kHz. Two MAGICs, neither of which can collide with a JSON control frame
(those start with 0x7B, '{'):
  byte 0     MAGIC. 0x01 = per-participant TAGGED PCM (per-stream diarization).
             0x02 = MIXED recording PCM: the archive flow that keeps
             channel.keepAudio working while per-stream is granted.
  byte 1     tag u8 — the participant tag for 0x01; ALWAYS 0 and ignored for 0x02.
  bytes 2-3  reserved u16 = 0 (keeps the PCM 16-bit aligned)
  bytes 4-7  meetingTimeMs u32 LE — the bot's meeting clock for this frame
  bytes 8..  PCM payload
The legacy MIXED path (no per-stream grant) still ships bare, header-less PCM
through enqueue(), byte-for-byte as before.

Lifecycle (#C1/#C3/#C5/#C12) — the Transcriber closes this socket on entirely
routine events (a session-list change, a channel replacement, a pod restart, an
LB re-route: doc/production-topology.md states there is no affinity across
reconnects). That close is OBSERVED here: ready/per_stream/mixed_recording are
cleared, the send queue keeps buffering with BOUNDED drop-oldest instead of
growing without limit, and the socket is re-opened with bounded exponential
backoff + jitter, re-running the init handshake and honouring the NEW grant
(which may differ — a reconnect can land on another instance). Because that
handshake is what rebuilds the Transcriber's tag -> participant map, the re-run
carries the CURRENT roster (`participants_provider`), not an empty list. Once the
retries are exhausted `on_failure(reason)` is invoked so the owner (BrokerClient)
publishes the bot-error the Scheduler re-routes on.
"""
import asyncio
import inspect
import json
import os
import random
from collections import deque

import websockets

ACK_TIMEOUT_S = 10

# Wire MAGICs — see the frame layout above.
MAGIC_TAGGED = 0x01
MAGIC_MIXED = 0x02

# Queue entry classes, in DROP priority order: a full queue sheds the mixed
# recording flow first (a shorter archive beats lost captions), then tagged/bare
# audio; control frames are never dropped.
_KIND_CONTROL = 0
_KIND_AUDIO = 1
_KIND_MIXED = 2

# Warn on the FIRST drop, then only every this many further drops (mirrors the JS
# sibling's DROP_WARN_EVERY): every drop is counted, the log is throttled.
DROP_WARN_EVERY = 100


def _env_int(name: str, default: int, minimum: int) -> int:
    """Read a positive-integer knob, falling back to `default` on garbage."""
    try:
        value = int(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        return default
    return value if value >= minimum else default


class _SendQueue:
    """Bounded FIFO for the single writer, with PRIORITY drop-oldest (#C5).

    asyncio.Queue's default maxsize=0 is UNBOUNDED: with no consumer draining it
    (the writer stops the moment the socket is gone) the audio pump grows RSS
    without limit. This queue caps the depth and, when full, drops the oldest
    MIXED recording frame first, then the oldest audio frame. JSON control frames
    (participant join/leave/rename, speakerChanged) are NEVER dropped: they carry
    the tag -> display-name mapping every later caption is attributed with.

    The asyncio.Queue surface used by the stream and the tests (put_nowait /
    get_nowait / qsize) is kept, so callers do not care which one they hold.
    """

    def __init__(self, maxsize: int) -> None:
        self.maxsize = maxsize
        self.dropped = 0
        self._items: deque = deque()
        self._wakeup = asyncio.Event()

    def qsize(self) -> int:
        return len(self._items)

    def put_nowait(self, item, kind: int = _KIND_AUDIO) -> None:
        if self.maxsize > 0 and len(self._items) >= self.maxsize:
            self._drop_one()
        self._items.append((kind, item))
        self._wakeup.set()

    def put_front(self, item, kind: int = _KIND_AUDIO) -> None:
        """Hand an unsent frame back to the HEAD of the queue (the link died
        between the get and the send), so ordering survives a reconnect and a
        mode change can discard it with clear_audio() like any other frame."""
        if self.maxsize > 0 and len(self._items) >= self.maxsize:
            self._drop_one()
        self._items.appendleft((kind, item))
        self._wakeup.set()

    def get_nowait(self):
        return self._items.popleft()[1]

    async def get(self):
        return (await self.get_entry())[1]

    async def get_entry(self) -> tuple:
        while not self._items:
            self._wakeup.clear()
            await self._wakeup.wait()
        return self._items.popleft()

    def clear_audio(self) -> int:
        """Drop every queued AUDIO frame, keeping control messages.

        Used when a reconnect grants a DIFFERENT mode: the buffered frames were
        built in the previous wire shape (tagged vs bare PCM) and the new
        Transcriber would decode them as garbage audio."""
        kept = deque(e for e in self._items if e[0] == _KIND_CONTROL)
        removed = len(self._items) - len(kept)
        self._items = kept
        return removed

    def _drop_one(self) -> None:
        for kind in (_KIND_MIXED, _KIND_AUDIO):
            for index, entry in enumerate(self._items):
                if entry[0] == kind:
                    del self._items[index]
                    self.dropped += 1
                    return
        # Only control frames left: never drop those. Control traffic is a handful
        # of messages per participant, so letting the queue sit at its cap is safe.


class TranscriberStream:
    def __init__(
        self,
        url: str,
        diarization_mode: str = "asr",
        ack_timeout: float = ACK_TIMEOUT_S,
        per_stream: bool = False,
        on_failure=None,
    ) -> None:
        self.url = url
        self.diarization_mode = diarization_mode
        self.ack_timeout = ack_timeout

        # perStream (PHASE 3): `requested_per_stream` is what we advertise in the
        # init frame; `per_stream` is the EFFECTIVE mode, set only once the
        # Transcriber acks back `perStream:true` (D9 — honour the ACK). Until the
        # ack arrives it stays False, so the legacy mixed path is the default.
        self.requested_per_stream = per_stream
        self.per_stream = False
        # mixedRecording is NEVER read back from our own request: init advertises
        # the CAPABILITY, the ack decides. True means the Transcriber is archiving
        # channel.keepAudio from the 0x02 flow, so this bot MUST ship it.
        self.mixed_recording = False

        self.ws = None
        self.ready = False
        self._closed = False
        self._failed = False

        # Called with a reason string once the reconnect retries are exhausted.
        # BrokerClient wires it to publish botservice/out/<botId>/bot-error and
        # stop the bot; sync and async callables are both accepted.
        self.on_failure = on_failure
        # Optional sync hook fired whenever the EFFECTIVE per-stream mode changes
        # (link lost, or a reconnect granted differently). The audio producer owns
        # the mixer, so it is the one that has to react — see LiveKitBot.
        self.on_mode_change = None
        # Optional sync callable returning the CURRENT participant roster, in the
        # init frame's shape: [{"id":…, "name":…, "tag":…}, …]. The init handshake
        # is RE-RUN on every reconnect and the Transcriber rebuilds its per-stream
        # tag -> participant map from scratch out of that list, so a hard-coded
        # empty roster silently destroys speaker attribution for the rest of the
        # call. The owner (LiveKitBot) wires its live roster here.
        self.participants_provider = None

        self.max_queue = _env_int("VISIOBOT_WS_MAX_QUEUE_FRAMES", 500, 1)
        self.reconnect_retries = _env_int("VISIOBOT_WS_RECONNECT_RETRIES", 3, 0)
        self.reconnect_base_ms = _env_int("VISIOBOT_WS_RECONNECT_BASE_MS", 1000, 1)

        # One queue, one writer: order is preserved without a task per frame.
        self.q = _SendQueue(self.max_queue)
        self._last_warned_drops = 0

        self._recv_task: asyncio.Task | None = None
        self._writer_task: asyncio.Task | None = None
        self._reconnect_task: asyncio.Task | None = None
        self._ack_event = asyncio.Event()
        # Set while the CURRENT socket is ack'd. The writer only sends while it is
        # set and holds (buffers) otherwise, so a reconnect gap costs frames only
        # once the bounded queue overflows.
        self._link = asyncio.Event()
        # True once we own the recv task, i.e. the socket lifecycle is ours to
        # supervise. A bare _recv() drive (pre-connect / unit tests) is not.
        self._supervised = False
        self._acked_once = False
        # Last mode the Transcriber actually GRANTED. It survives a socket close
        # (unlike `per_stream`, which is cleared with the link) so a reconnect can
        # tell an unchanged grant from a genuinely different one.
        self._last_granted_per_stream = False
        # Last GRANT handed to on_mode_change, so the hook only sees transitions.
        # BOTH negotiated axes are tracked: a re-grant that keeps perStream but
        # flips mixedRecording still has to re-align the producer's mixer.
        self._notified_per_stream = False
        self._notified_mixed = False
        self._handshake_error: str | None = None

    async def connect(self) -> None:
        """Open the socket, send init, and wait (watchdog) for the ack."""
        await self._open_socket()
        await self._await_ack()
        # One long-lived writer across reconnects: it holds on `_link` while the
        # socket is down instead of dying with it.
        self._writer_task = asyncio.create_task(self._writer())

    # ---- handshake ---------------------------------------------------------
    async def _open_socket(self) -> None:
        """(Re)open the WS and re-run the init handshake on it."""
        self._ack_event.clear()
        self._handshake_error = None
        self.ready = False
        self._link.clear()
        self.ws = await websockets.connect(self.url, max_size=None)
        await self._send_init()
        self._supervised = True
        self._recv_task = asyncio.create_task(self._recv())

    async def _await_ack(self) -> None:
        try:
            await asyncio.wait_for(self._ack_event.wait(), timeout=self.ack_timeout)
        except asyncio.TimeoutError as e:
            raise RuntimeError(
                f"TranscriberStream: no ack within {self.ack_timeout}s"
            ) from e
        # An explicit {type:'error'} is a REJECTED init — and a socket that died
        # mid-handshake records the same way: the ack will never come, so fail now
        # rather than sitting out the whole watchdog blindly.
        if self._handshake_error is not None:
            raise RuntimeError(
                f"TranscriberStream: init handshake failed: {self._handshake_error}"
            )

    def _roster(self) -> list:
        """The participant roster to advertise in the init frame.

        On the FIRST connect the room is not joined yet (LiveKitBot.start() joins
        strictly after the handshake), so this is empty and every participant is
        announced by a `participant/join` control message from the post-connect
        sweep. On a RECONNECT it is not: the Transcriber rebuilds its tag ->
        participant map from scratch out of this list (and its SpeakerTracker
        roster in the mixed path), and nothing re-announces the joins — the bot's
        own register path early-returns for an identity it already knows, and
        LiveKit fires no new join events. Sending an empty list there left every
        sub-ASR created after the reconnect unattributed (participantId/
        participantName null) for the rest of the call.

        Fail-soft: a provider that raises must not break the handshake, so it
        degrades to the empty roster (the pre-existing behaviour)."""
        provider = self.participants_provider
        if provider is None:
            return []
        try:
            return list(provider() or [])
        except Exception as e:  # noqa: BLE001
            print(
                f"TranscriberStream: participants_provider raised ({e}); sending an "
                "empty init roster",
                flush=True,
            )
            return []

    async def _send_init(self) -> None:
        # `participants` carries the CURRENT roster (see _roster): empty on the
        # first connect, the live roster on every reconnect — the Transcriber
        # rebuilds its per-stream tag -> participant map from exactly this list.
        #
        # `mixedRecording` is a pure CAPABILITY advertisement ("I can produce a
        # mixed flow alongside the tagged ones"), harmless to an older Transcriber
        # that ignores unknown init keys. It is what lets the Transcriber grant
        # per-stream on a channel that must be archived (keepAudio) instead of
        # demoting us to the legacy mixed path.
        await self.ws.send(
            json.dumps(
                {
                    "type": "init",
                    "encoding": "pcm",
                    "sampleRate": 16000,
                    "diarizationMode": self.diarization_mode,
                    "perStream": self.requested_per_stream,
                    "mixedRecording": True,
                    "participants": self._roster(),
                }
            )
        )

    def _on_ack(self, obj: dict) -> None:
        granted_per_stream = bool(obj.get("perStream"))
        granted_mixed = bool(obj.get("mixedRecording"))
        # Compare against the last GRANT, not against `per_stream`: the close
        # handler already cleared that, so it would never look like a change.
        previous_per_stream = self._last_granted_per_stream
        previous_mixed = self.mixed_recording

        # A reconnect can land on a DIFFERENT Transcriber instance whose grant
        # differs (no affinity across reconnects — doc/production-topology.md).
        # Honour the NEW ack, and drop the queued audio: it was framed for the
        # previous mode and the new instance would decode it as garbage.
        if self._acked_once and granted_per_stream != previous_per_stream:
            removed = self.q.clear_audio()
            print(
                "TranscriberStream: WARNING — the reconnected Transcriber granted "
                f"perStream={granted_per_stream} (was {previous_per_stream}); "
                f"{removed} buffered frame(s) in the old wire shape were dropped",
                flush=True,
            )

        self.per_stream = granted_per_stream
        self._last_granted_per_stream = granted_per_stream
        self.mixed_recording = granted_mixed

        if not self.ready:
            if self.requested_per_stream and not self.per_stream:
                # Loud on purpose: this is the ONE way per-stream diarization
                # silently degrades to the mixed path (energy-VAD speaker guessing
                # instead of one ASR per participant). Either the Transcriber
                # serving this bot does not have TRANSCRIBER_PERSTREAM_DIARIZATION
                # =true, or it archives this channel (keepAudio) and refused to
                # grant per-stream — a deployment mistake, not a runtime event.
                print(
                    "TranscriberStream: WARNING — requested perStream "
                    "diarization but the Transcriber acked perStream="
                    "false; falling back to MIXED audio (approximate "
                    "speaker attribution). Set "
                    "TRANSCRIBER_PERSTREAM_DIARIZATION=true on the "
                    "Transcriber to enable it.",
                    flush=True,
                )
            self.ready = True

        if self.mixed_recording and not previous_mixed:
            # The Transcriber is archiving this channel from the 0x02 flow, so the
            # bot owes it a mixed stream on top of the tagged ones.
            print(
                "TranscriberStream: mixedRecording GRANTED — this channel is "
                "archived from the mixed (0x02) flow alongside the tagged audio",
                flush=True,
            )

        self._acked_once = True
        self._link.set()
        self._ack_event.set()
        self._notify_mode_change()

    # ---- socket loops ------------------------------------------------------
    async def _recv(self) -> None:
        # Bind the socket this loop belongs to: a stale loop must not drive the
        # lifecycle of the socket that replaced it.
        ws = self.ws
        try:
            async for message in ws:
                if isinstance(message, (bytes, bytearray)):
                    continue
                try:
                    obj = json.loads(message)
                except Exception:  # noqa: BLE001
                    continue
                message_type = obj.get("type")
                if message_type == "ack":
                    self._on_ack(obj)
                elif message_type == "error":
                    # The Transcriber rejects a malformed/refused init with
                    # {type:'error', message}. Record it and release the watchdog.
                    self._handshake_error = obj.get("message") or "unspecified error"
                    print(
                        "TranscriberStream: the Transcriber rejected the handshake: "
                        f"{self._handshake_error}",
                        flush=True,
                    )
                    self._ack_event.set()
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 — a peer close raises here
            if not self._closed:
                print(f"TranscriberStream: receive loop ended: {e}", flush=True)
        finally:
            self._on_socket_closed(ws)

    def _on_socket_closed(self, ws) -> None:
        """Observe a socket close: invalidate the negotiated state and reconnect.

        Only the socket still attached to this stream drives the lifecycle — a
        stale one from an abandoned attempt must not — and only while we own the
        recv task (`_supervised`)."""
        if not self._supervised or ws is not self.ws:
            return
        if self._closed or self._failed:
            return
        # The link is down: stop advertising a negotiated mode. Frames produced in
        # the gap keep flowing into the BOUNDED queue (drop-oldest) rather than
        # into a socket nobody reads any more.
        self.ready = False
        self.per_stream = False
        self.mixed_recording = False
        self._link.clear()
        if not self._ack_event.is_set():
            # The socket died while a handshake was still pending. `_await_ack` is
            # parked on its watchdog and no ack can ever arrive on a socket that is
            # provably gone, so release it with a reason instead of burning the
            # full ACK_TIMEOUT_S — that delay is paid by connect() (the join-failed
            # bot-error the Scheduler re-routes on) and by EVERY reconnect attempt.
            # `_await_ack` already raises on a non-None _handshake_error.
            self._handshake_error = (
                self._handshake_error or "socket closed before the ack"
            )
            self._ack_event.set()
        # A link LOSS is a SIGNAL, never a grant: notify, but do NOT record it as
        # the notified state (see _notify_mode_change).
        self._notify_mode_change(record=False)
        if not self._acked_once:
            # The handshake never completed: connect() is still on its watchdog and
            # will fail the whole bot (join-failed). Never reconnect a link that was
            # never established.
            return
        if self._reconnect_task is None or self._reconnect_task.done():
            self._reconnect_task = asyncio.create_task(self._reconnect())

    async def _reconnect(self) -> None:
        attempt = 0
        while not self._closed and attempt < self.reconnect_retries:
            attempt += 1
            # Exponential backoff with full jitter, so the N bots that lost the
            # same Transcriber pod do not stampede its replacement in lockstep.
            delay = (self.reconnect_base_ms / 1000.0) * (2 ** (attempt - 1))
            delay += random.uniform(0, delay)
            print(
                f"TranscriberStream: socket closed, reconnect attempt "
                f"{attempt}/{self.reconnect_retries} in {delay:.1f}s",
                flush=True,
            )
            await asyncio.sleep(delay)
            if self._closed:
                return
            try:
                await self._open_socket()
                await self._await_ack()
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                print(
                    f"TranscriberStream: reconnect attempt {attempt} failed: {e}",
                    flush=True,
                )
                await self._abandon_socket()
                continue
            print(
                f"TranscriberStream: reconnected (perStream={self.per_stream}, "
                f"mixedRecording={self.mixed_recording})",
                flush=True,
            )
            return

        if self._closed:
            return
        # Retries exhausted: a sustained Transcriber outage is fatal for this bot.
        # Surface it so the Scheduler can re-route instead of leaving a bot that
        # streams into the void while still counted in activeBots.
        self._failed = True
        self.ready = False
        self._link.clear()
        print(
            f"TranscriberStream: ERROR — transcriber unreachable, gave up after "
            f"{attempt} reconnect attempt(s)",
            flush=True,
        )
        await self._notify_failure("transcriber-unreachable")

    async def _abandon_socket(self) -> None:
        """Drop a half-open socket WITHOUT re-entering the close handler (self.ws
        is detached first, so the dying recv loop sees itself as stale)."""
        ws, self.ws = self.ws, None
        task, self._recv_task = self._recv_task, None
        current = asyncio.current_task()
        if task is not None and task is not current:
            task.cancel()
        if ws is not None:
            try:
                await ws.close()
            except Exception:  # noqa: BLE001
                pass

    async def _notify_failure(self, reason: str) -> None:
        callback = self.on_failure
        if callback is None:
            print(
                f"TranscriberStream: {reason} with no on_failure owner wired — "
                "the bot will stay up with no transcription",
                flush=True,
            )
            return
        try:
            result = callback(reason)
            if inspect.isawaitable(result):
                await result
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            print(f"TranscriberStream: on_failure({reason}) raised: {e}", flush=True)

    def _notify_mode_change(self, record: bool = True) -> None:
        """Fire on_mode_change on a real transition of the negotiated mode.

        The ACK is the AUTHORITY (`record=True`). It compares BOTH negotiated axes
        — perStream AND mixedRecording — against the last GRANT that was notified,
        so a re-ack that grants exactly the same thing stays silent while a
        reconnect that demotes the grant, or one that only revokes/grants the
        archive flow, always reaches the hook.

        A link LOSS (`record=False`) clears the effective mode but grants nothing,
        so it is signalled and NOT recorded. Recording it was the bug: the owner
        discards a link-down notification (the mixer must keep the granted wire
        shape across the gap), yet the recorded state then made the reconnect's
        perStream=false ack look unchanged — the hook never fired, `_align_mixer`
        never re-ran, and the producer kept emitting tagged/0x02 frames into a
        Transcriber back on the legacy path, which forwards them verbatim as PCM.
        """
        if record:
            if (self.per_stream, self.mixed_recording) == (
                self._notified_per_stream,
                self._notified_mixed,
            ):
                return
            self._notified_per_stream = self.per_stream
            self._notified_mixed = self.mixed_recording
        callback = self.on_mode_change
        if callback is None:
            return
        try:
            callback(self.per_stream)
        except Exception as e:  # noqa: BLE001
            print(f"TranscriberStream: on_mode_change raised: {e}", flush=True)

    async def _writer(self) -> None:
        entry = None
        try:
            while not self._closed:
                if entry is None:
                    entry = await self.q.get_entry()
                if self._closed:
                    break
                if not self._link.is_set():
                    # Link down: hand the frame BACK to the (bounded) queue rather
                    # than holding it out of reach — a reconnect that grants another
                    # mode has to be able to discard it too — then wait for the
                    # replacement socket to be ack'd.
                    self.q.put_front(entry[1], entry[0])
                    entry = None
                    await self._link.wait()
                    continue
                ws = self.ws
                try:
                    await ws.send(entry[1])
                    entry = None
                except asyncio.CancelledError:
                    raise
                except Exception:  # noqa: BLE001
                    # The socket died mid-send: requeue the frame for the
                    # replacement link. The recv loop's close handler drives the
                    # reconnect.
                    self.q.put_front(entry[1], entry[0])
                    entry = None
                    self._link.clear()
        except asyncio.CancelledError:
            pass
        except Exception as e:  # noqa: BLE001
            print(f"TranscriberStream: writer stopped: {e}", flush=True)

    # ---- producer side -----------------------------------------------------
    def _put(self, item, kind: int) -> None:
        if self._closed:
            return
        before = self.q.dropped
        self.q.put_nowait(item, kind)
        if self.q.dropped != before:
            self._warn_drops()

    def _warn_drops(self) -> None:
        dropped = self.q.dropped
        # Log the FIRST drop, then in batches — never once per frame.
        if dropped == 1 or dropped - self._last_warned_drops >= DROP_WARN_EVERY:
            self._last_warned_drops = dropped
            print(
                f"TranscriberStream: WARNING — send queue full ({self.q.maxsize} "
                f"frames), {dropped} audio frame(s) dropped so far (transcriber "
                "link down or slow)",
                flush=True,
            )

    def enqueue(self, frame_bytes: bytes) -> None:
        """Queue one bare (legacy MIXED path) PCM frame on the single-writer queue.

        Callers only exist after the ack (the mixer is started and the track
        pumps are wired after connect() returns), so there is no pre-ack audio
        to hold back."""
        self._put(frame_bytes, _KIND_AUDIO)

    def _enqueue_framed(self, magic: int, tag: int, t_ms: int, pcm: bytes) -> None:
        """Build and queue one 8-byte-header binary frame (layout in the module
        docstring). Shared by the tagged (0x01) and mixed (0x02) flows so the two
        can never drift apart on the wire."""
        header = bytes([magic & 0xFF, tag & 0xFF, 0, 0]) + (
            t_ms & 0xFFFFFFFF
        ).to_bytes(4, "little")
        self._put(
            header + pcm, _KIND_MIXED if magic == MAGIC_MIXED else _KIND_AUDIO
        )

    def enqueue_tagged(self, tag: int, t_ms: int, pcm: bytes) -> None:
        """Queue one per-stream tagged audio frame (PHASE 3): MAGIC 0x01, the
        participant's stable u8 tag, and the meeting clock the Transcriber's
        sub-ASR builds its audio->meeting timeline map from."""
        self._enqueue_framed(MAGIC_TAGGED, tag, t_ms, pcm)

    def enqueue_mixed(self, t_ms: int, pcm: bytes) -> None:
        """Queue one MIXED recording frame: MAGIC 0x02, tag ALWAYS 0.

        In per-stream mode the Transcriber has no mixed flow of its own, so a
        channel with keepAudio=true is archived from this second flow. It is never
        transcribed, which is exactly why it is the FIRST thing shed when the send
        queue overflows — a shorter archive beats lost captions."""
        self._enqueue_framed(MAGIC_MIXED, 0, t_ms, pcm)

    def send_speaker_change(self, position: int, speaker: dict | None) -> None:
        """Forward a native-diarization speaker transition. Mirrors the WEB bot's
        `speakerChanged` control message; like send_participant it rides the same
        single-writer queue, so order is preserved.

        `speaker` is {"id":…, "name":…} for a new dominant speaker, or None for a
        silence transition. The Transcriber's SpeakerTracker keys captions off
        `speaker.name` (the real display name); `position` is informational."""
        if self._closed:
            return
        try:
            self._put(
                json.dumps(
                    {
                        "type": "speakerChanged",
                        "position": position,
                        "speaker": speaker,
                    }
                ),
                _KIND_CONTROL,
            )
        except Exception:  # noqa: BLE001
            pass

    def send_participant(self, action: str, pid: str, name: str, tag: int | None = None) -> None:
        """Forward a participant control message (join/leave/rename). The writer
        ships it as soon as the socket is up. Control is infrequent, so routing it
        through the same queue keeps a single writer and preserves order without a
        task-per-message.

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
            self._put(
                json.dumps(
                    {
                        "type": "participant",
                        "action": action,
                        "participant": participant,
                    }
                ),
                _KIND_CONTROL,
            )
        except Exception:  # noqa: BLE001
            pass

    async def close(self) -> None:
        self._closed = True
        # An intentional close invalidates the negotiated state too, so nothing
        # keeps reading a mode off a stream that no longer has a link.
        self.ready = False
        self.per_stream = False
        self.mixed_recording = False
        # Release a writer parked on the link so its cancellation lands at once.
        self._link.set()
        # close() can be reached FROM the reconnect task (on_failure -> stop_bot ->
        # dispose): never cancel the task we are running on.
        current = asyncio.current_task()
        for task in (self._recv_task, self._writer_task, self._reconnect_task):
            if task is not None and task is not current:
                task.cancel()
        if self.ws is not None:
            try:
                await self.ws.close()
            except Exception:  # noqa: BLE001
                pass
