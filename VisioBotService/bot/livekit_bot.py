"""LiveKitBot — smoke_connect.py taken down to the service level.

Joins one LiveKit room as a HIDDEN participant (can_subscribe, !can_publish),
subscribes to every remote audio track, pumps each track's frames into the
AudioMixer and forwards the mixed stream to the Transcriber.

Token is minted LOCALLY from LIVEKIT_API_KEY/SECRET (env) — no secret ever
travels over MQTT. livekit 1.1.12 signatures match smoke_connect.py exactly.
"""
import asyncio
import heapq
import os
import time

from livekit import rtc
from livekit.api import AccessToken, VideoGrants

from bot.audio_mixer import AudioMixer, rms_s16le
from bot.transcriber_stream import TranscriberStream

# Tag 255 is the Transcriber's RESERVED overflow/mixed sentinel: per-stream
# frames carrying this tag are routed to the shared "overflow" ASR instead of a
# dedicated per-participant sub-ASR. Normal participants therefore get tags in
# 0..254; 255 is only ever handed out when those 255 slots are all in use.
OVERFLOW_TAG = 255


class LiveKitBot:
    def __init__(self, livekit_url: str, room_name: str, websocket_url: str, bot_id=None) -> None:
        self.livekit_url = livekit_url
        self.room_name = room_name
        self.websocket_url = websocket_url
        self.bot_id = bot_id

        self.api_key = os.environ.get("LIVEKIT_API_KEY", "devkey")
        self.api_secret = os.environ.get("LIVEKIT_API_SECRET", "secret")

        # perStream (PHASE 3): opt-in via BOT_PERSTREAM. The init frame advertises
        # diarizationMode "native" in BOTH paths now — the mixed path derives the
        # "who is speaking" signal from the mixer's energy VAD (real display name),
        # exactly like the WEB bot, instead of leaving it to the ASR provider's
        # internal "Guest-N" diarization. perStream additionally sets perStream:true
        # and tags frames; the EFFECTIVE mode is still decided by the Transcriber
        # ACK (honoured inside transcriber.connect()).
        self.requested_per_stream = os.environ.get("BOT_PERSTREAM") in ("1", "true")
        mode = "native"

        self._participants: dict[str, str] = {}  # identity -> name
        self._pump_tasks: set[asyncio.Task] = set()
        self._pumped: set = set()  # track sids already being pumped

        # perStream tagging + VAD gate (no numpy). Tags are a recycled pool over
        # 0..254 (OVERFLOW_TAG=255 is reserved): `_free_tags` is a min-heap of
        # tags returned by departed participants, `_next_tag` is the high-water
        # mark capped at OVERFLOW_TAG so we never wrap past 255 onto live tags.
        self._tags: dict[str, int] = {}  # identity -> stable u8 tag
        self._free_tags: list[int] = []  # min-heap of recycled tags (lowest first)
        self._next_tag = 0
        self._vad_state: dict[str, float] = {}  # identity -> last-active ts (hysteresis)
        self._vad_thr = int(os.environ.get("BOT_VAD_ENERGY_THRESHOLD", "300"))
        self._t0 = time.monotonic()  # bot-relative clock origin

        self.room = rtc.Room()
        self.transcriber = TranscriberStream(
            websocket_url,
            self._participants_list,
            diarization_mode=mode,
            per_stream=self.requested_per_stream,
        )
        # Mixed mode only: the mixer mixes audio AND emits native speaker
        # transitions (loudest participant above _vad_thr) carrying the real name.
        self.mixer = AudioMixer(
            on_frame=self._on_mixed_frame,
            on_speaker_change=self._on_speaker_change,
            energy_threshold=self._vad_thr,
        )

    # ---- token ------------------------------------------------------------
    def _token(self) -> str:
        return (
            AccessToken(self.api_key, self.api_secret)
            .with_identity(f"linto-visio-bot-{self.room_name}")
            .with_name("LinTO")
            .with_grants(
                VideoGrants(
                    room_join=True,
                    room=self.room_name,
                    can_subscribe=True,
                    can_publish=False,
                    hidden=True,
                )
            )
            .to_jwt()
        )

    def _participants_list(self):
        # `name` carries the LiveKit DISPLAY NAME (set in _register_participant),
        # NOT the identity/UUID — it becomes the caption locutor in perStream (D8).
        return [
            {"id": ident, "name": name, "tag": self._tag_for(ident)}
            for ident, name in self._participants.items()
        ]

    # ---- perStream tagging / VAD ------------------------------------------
    def _tag_for(self, identity: str) -> int:
        """Stable u8 tag per participant identity, drawn from a recycled pool.

        Allocation order: a known identity keeps its tag; otherwise reuse the
        smallest tag freed by a departed participant; otherwise take the next
        fresh tag while one is available (`_next_tag < OVERFLOW_TAG`); when all
        of 0..254 are in use, hand out the shared OVERFLOW_TAG (255). We never
        mask-and-wrap, so a 256th+ concurrent identity can never collide with a
        still-present participant on tag 0,1,…
        """
        tag = self._tags.get(identity)
        if tag is not None:
            return tag
        if self._free_tags:
            tag = heapq.heappop(self._free_tags)
        elif self._next_tag < OVERFLOW_TAG:
            tag = self._next_tag
            self._next_tag += 1
        else:
            tag = OVERFLOW_TAG
        self._tags[identity] = tag
        return tag

    def _now_ms(self) -> int:
        """Bot-relative monotonic clock in milliseconds (u32-safe)."""
        return int((time.monotonic() - self._t0) * 1000) & 0xFFFFFFFF

    def _vad_active(self, identity: str, pcm: bytes) -> bool:
        """Energy VAD on s16le mono PCM, no numpy. RMS compared to the env
        threshold BOT_VAD_ENERGY_THRESHOLD (default 300), with ~200 ms hysteresis
        (a frame stays "active" up to 200 ms after the last frame above threshold)."""
        now = time.monotonic()
        rms = rms_s16le(pcm)
        if rms >= self._vad_thr:
            self._vad_state[identity] = now
            return True
        last = self._vad_state.get(identity)
        return last is not None and (now - last) <= 0.2

    def _on_mixed_frame(self, frame_bytes: bytes) -> None:
        self.transcriber.enqueue(frame_bytes)

    def _on_speaker_change(self, speaker) -> None:
        # Native diarization transition from the mixer's energy VAD. `speaker` is
        # {"id","name"} (real display name) or None for silence. NOT ack-gated.
        self.transcriber.send_speaker_change(self._now_ms(), speaker)

    # ---- lifecycle --------------------------------------------------------
    async def start(self) -> bool:
        # 1. Transcriber first: connect → init → ack. If the Transcriber never
        #    acks, fail the whole bot (nothing to stream to).
        try:
            await self.transcriber.connect()
        except Exception as e:  # noqa: BLE001
            print(f"LiveKitBot: transcriber connect failed: {e}", flush=True)
            try:
                await self.transcriber.close()
            except Exception:  # noqa: BLE001
                pass
            return False

        # 2. Start the 20 ms mixer tick — ONLY in mixed mode. The ACK was already
        #    received inside transcriber.connect() above, so per_stream is final
        #    here (before the sweep / any _pump). In perStream the mixer stays
        #    idle and frames are tagged + bypassed straight to the Transcriber.
        if not self.transcriber.per_stream:
            self.mixer.start()

        # 3. Wire room events BEFORE connecting so nothing published between
        #    connect() and the post-connect sweep is missed.
        self.room.on("track_subscribed", self._on_track_subscribed)
        self.room.on("participant_connected", self._on_participant_connected)
        self.room.on("participant_disconnected", self._on_participant_disconnected)
        self.room.on("participant_name_changed", self._on_participant_name_changed)

        # 4. Join the room (hidden).
        try:
            await self.room.connect(
                self.livekit_url,
                self._token(),
                options=rtc.RoomOptions(auto_subscribe=True),
            )
        except Exception as e:  # noqa: BLE001
            print(f"LiveKitBot: room.connect failed: {e}", flush=True)
            await self.dispose()
            return False

        print(
            f"LiveKitBot: connected room={self.room.name} "
            f"participants={len(self.room.remote_participants)}",
            flush=True,
        )

        # 5. Sweep participants/tracks already present at connect time (a track
        #    already subscribed won't re-fire track_subscribed).
        for identity, participant in self.room.remote_participants.items():
            self._register_participant(participant)
            for pub in participant.track_publications.values():
                track = getattr(pub, "track", None)
                if track is not None and track.kind == rtc.TrackKind.KIND_AUDIO:
                    self._start_pump(track, identity)

        return True

    # ---- event handlers (sync paho-style callbacks from the SDK) ----------
    def _on_track_subscribed(self, track, publication, participant) -> None:
        if track.kind == rtc.TrackKind.KIND_AUDIO:
            self._start_pump(track, participant.identity)

    def _on_participant_connected(self, participant) -> None:
        self._register_participant(participant)

    def _on_participant_disconnected(self, participant) -> None:
        ident = participant.identity
        name = self._participants.pop(ident, None)
        # Drop the mixer state too so a departed participant can't stay the
        # "current speaker" (no-op in perStream, where the mixer is idle).
        self.mixer.remove_participant(ident)
        # Recycle the tag back to the pool so a later joiner reuses a low tag
        # instead of pushing _next_tag toward OVERFLOW_TAG. This is what lets the
        # Transcriber's per-participant 'leave' teardown actually free an ASR
        # slot. OVERFLOW_TAG is shared and never owned by a single identity, so
        # it is dropped rather than recycled.
        tag = self._tags.pop(ident, None)
        if tag is not None and tag != OVERFLOW_TAG:
            heapq.heappush(self._free_tags, tag)
        if name is not None:
            self.transcriber.send_participant("leave", ident, name, tag)

    def _on_participant_name_changed(self, participant, *args) -> None:
        # BONUS: the LiveKit display name can change mid-call (rename). Refresh
        # the memorised name and the participants list so subsequent captions
        # (and the re-emitted speaker transition) use it. The handler signature
        # varies across livekit-rtc versions, hence *args; the new name is read
        # from the participant object, which is always passed.
        ident = getattr(participant, "identity", None)
        if ident is None:
            return
        name = getattr(participant, "name", None) or ident
        if self._participants.get(ident) == name:
            return
        self._participants[ident] = name
        # Mixed mode: refresh the mixer so the next energy-VAD speaker transition
        # carries the new name (no-op when the mixer is idle in perStream).
        self.mixer.update_name(ident, name)
        # perStream: the mixer is idle, so emit an explicit 'rename' control
        # message — the Transcriber's already-created sub-ASR is keyed by tag and
        # updates its display name live. Without this the sub-ASR would keep the
        # old name for the rest of the call.
        if self.transcriber.per_stream:
            self.transcriber.send_participant("rename", ident, name, self._tag_for(ident))

    def _register_participant(self, participant) -> None:
        ident = participant.identity
        if ident in self._participants:
            return
        name = getattr(participant, "name", None) or ident
        self._participants[ident] = name
        self.transcriber.send_participant("join", ident, name, self._tag_for(ident))

    def _start_pump(self, track, identity: str) -> None:
        sid = getattr(track, "sid", None) or id(track)
        if sid in self._pumped:
            return
        self._pumped.add(sid)
        task = asyncio.create_task(self._pump(track, identity))
        self._pump_tasks.add(task)
        task.add_done_callback(self._pump_tasks.discard)

    async def _pump(self, track, identity: str) -> None:
        # rtc.AudioStream already resamples to 16 kHz mono s16le — just relay
        # ev.frame.data bytes to the mixer (no numpy, no manual resample).
        stream = rtc.AudioStream(track, sample_rate=16000, num_channels=1)
        try:
            async for ev in stream:
                data = ev.frame.data
                pcm = data.tobytes() if hasattr(data, "tobytes") else bytes(data)
                if self.transcriber.per_stream:
                    # perStream: VAD-gate then ship the frame tagged. Silence
                    # produces no frame (no ASR, no worker).
                    if self._vad_active(identity, pcm):
                        self.transcriber.enqueue_tagged(
                            self._tag_for(identity), self._now_ms(), pcm
                        )
                else:
                    # Mixed: feed the mixer with the display name so the energy
                    # VAD can emit speakerChanged carrying the real name.
                    self.mixer.push(identity, pcm, self._participants.get(identity))
        except asyncio.CancelledError:
            pass
        except Exception:  # noqa: BLE001
            pass
        finally:
            try:
                await stream.aclose()
            except Exception:  # noqa: BLE001
                pass

    async def dispose(self) -> None:
        for task in list(self._pump_tasks):
            task.cancel()
        self._pump_tasks.clear()
        try:
            await self.room.disconnect()
        except Exception:  # noqa: BLE001
            pass
        try:
            await self.transcriber.close()
        except Exception:  # noqa: BLE001
            pass
        self.mixer.stop()
