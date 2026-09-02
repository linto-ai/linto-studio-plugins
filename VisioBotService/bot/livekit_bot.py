"""LiveKitBot — smoke_connect.py taken down to the service level.

Joins one LiveKit room as a HIDDEN participant (can_subscribe, !can_publish),
subscribes to every remote MICROPHONE track, pumps each track's frames into the
AudioMixer and/or the per-participant tagged flow, and forwards them to the
Transcriber.

Token: prefer a room-scoped bearer JWT supplied in the startbot payload (minted
by the room owner, Meet, with ITS secret — so no signing secret lives here and a
replica is credential-agnostic). Absent (dev fallback), it is minted LOCALLY from
LIVEKIT_API_KEY/SECRET (env). livekit 1.1.12 signatures match smoke_connect.py.
"""
import asyncio
import heapq
import os
import time

from livekit import rtc
from livekit.api import AccessToken, VideoGrants

from bot.audio_mixer import AudioMixer, rms_s16le
from bot.captions import SegmentClock, caption_to_segment, resolve_speaker
from bot.transcriber_stream import TranscriberStream

# Tag 255 is the Transcriber's RESERVED overflow/mixed sentinel: per-stream
# frames carrying this tag are routed to the shared "overflow" ASR instead of a
# dedicated per-participant sub-ASR. Normal participants therefore get tags in
# 0..254; 255 is only ever handed out when those 255 slots are all in use.
OVERFLOW_TAG = 255

# C2b: how long a frame stays "active" after the last frame above the energy
# threshold. It must exceed the provider's end-of-utterance silence timeout
# (Microsoft's default is ~500 ms), otherwise the VAD gate splices successive
# speech bursts end to end and the provider never sees enough trailing silence
# to finalize — every burst is concatenated into one run-on segment.
DEFAULT_VAD_HANGOVER_MS = 800

# Bound on the recently-departed maps consulted for late caption attribution
# (a final routinely lands after its speaker hung up). FIFO, so a long call with
# heavy churn cannot grow them without limit.
DEPARTED_MAX = 64
# Same idea for the "already left" set that blocks late tag allocation: an
# identity that left this long ago has no pump left to protect against.
LEFT_MAX = 512

# Log at most one publish_transcription failure, then one every this many: the
# overlay is best-effort and a broken data channel would otherwise emit one line
# per caption, several per second, for the rest of the call.
CAPTION_ERROR_WARN_EVERY = 100

# Auto-leave, same two clocks and the same env knobs as the web BotService
# (BotService/bot/index.js `envTimeoutMs`):
#   EMPTY_MEETING_TIMEOUT_SECONDS — once a participant HAS been seen, leave this
#     long after the last one is gone (the meeting is over: the owner is asked to
#     END the session, exactly like a manual stop);
#   JOIN_TIMEOUT_SECONDS — absolute watchdog: nobody was EVER seen after the
#     join (wrong room, empty room), so the empty-meeting timer never arms. That
#     leave is a FAILURE (join-timeout), not a clean end of meeting.
DEFAULT_EMPTY_MEETING_TIMEOUT_S = 60
DEFAULT_JOIN_TIMEOUT_S = 120


def _env_timeout_seconds(name: str, default_s: int) -> float:
    """Positive integer seconds from the environment, else `default_s` — the web
    bot's `envTimeoutMs` rule, so one .env line tunes both bot families."""
    try:
        value = int(os.environ.get(name, ""))
    except (TypeError, ValueError):
        return float(default_s)
    return float(value) if value > 0 else float(default_s)


def _cancel_handle(obj, attr: str) -> None:
    """Cancel and clear the asyncio handle stored under `obj.<attr>`, if any.
    Module-level and getattr-based on purpose: dispose() is borrowed by test
    stand-ins that are not LiveKitBot instances and carry no timer slots."""
    handle = getattr(obj, attr, None)
    if handle is None:
        return
    try:
        handle.cancel()
    except Exception:  # noqa: BLE001
        pass
    try:
        setattr(obj, attr, None)
    except Exception:  # noqa: BLE001
        pass


class LiveKitBot:
    # Defaults for the attributes methods read on instances built with __new__
    # (tests) — never mutable state, which stays per-instance in __init__.
    _stream_key = None
    _closing = False
    _failing = False
    # Auto-leave state (see the two timeouts above). Class-level so a bot built
    # with __new__ behaves as "nobody seen, no timer armed".
    _has_seen_participant = False
    _empty_meeting_handle = None
    _join_watchdog_handle = None
    _empty_meeting_timeout_s = float(DEFAULT_EMPTY_MEETING_TIMEOUT_S)
    _join_timeout_s = float(DEFAULT_JOIN_TIMEOUT_S)
    # Owner hooks (BrokerClient): called with no argument on the loop when the
    # meeting emptied out / when the join watchdog fired. Without an owner the bot
    # simply disposes itself.
    on_meeting_empty = None
    on_join_timeout = None

    def __init__(
        self,
        livekit_url: str,
        room_name: str,
        websocket_url: str,
        bot_id=None,
        join_token=None,
    ) -> None:
        self.livekit_url = livekit_url
        self.room_name = room_name
        self.websocket_url = websocket_url
        self.bot_id = bot_id
        # S2: `<sessionId>,<channelIndex>` tail of the Transcriber ingest URL —
        # the only per-CHANNEL identifier this service is given (the startbot
        # payload's room/token are session-scoped). Two channels of one session
        # share a LiveKit room, so it is what keeps their republished segment ids
        # apart and, in the dev env-mint path, their bot identities apart.
        self._stream_key = self._derive_stream_key(websocket_url)

        # join_token: a room-scoped bearer JWT minted by the room owner (Meet) and
        # carried in the startbot payload (meta.native/linto_native). When present
        # the bot NEVER signs its own token — the signing secret stays in Meet, so
        # a single credential-agnostic replica serves any tenant. Absent (dev
        # fallback), _token() env-mints below with the coinciding devkey/secret.
        self.join_token = join_token
        self.api_key = os.environ.get("LIVEKIT_API_KEY", "devkey")
        self.api_secret = os.environ.get("LIVEKIT_API_SECRET", "secret")

        # perStream: the DEFAULT mode of this service. VisioBotService exists only
        # for the Visio/Meet native bot, where one ASR per participant is what makes
        # a caption carry the participant's real name instead of an energy-VAD
        # guess; that is the mode this service is validated in, so it must not
        # depend on remembering an env var. Set BOT_PERSTREAM=false to force the
        # legacy mixed path (one mixed flow, one ASR, VAD-derived speaker).
        #
        # The init frame advertises diarizationMode "native" in BOTH paths — the
        # mixed path derives the "who is speaking" signal from the mixer's energy
        # VAD (real display name), exactly like the WEB bot, instead of leaving it
        # to the ASR provider's internal "Guest-N" diarization. perStream
        # additionally sets perStream:true and tags frames.
        #
        # The EFFECTIVE mode is still decided by the Transcriber ACK (honoured
        # inside transcriber.connect()): it only grants perStream when IT runs with
        # TRANSCRIBER_PERSTREAM_DIARIZATION=true. A denial is a deployment mistake,
        # so TranscriberStream warns loudly instead of degrading in silence.
        self.requested_per_stream = os.environ.get(
            "BOT_PERSTREAM", "true"
        ).strip().lower() in ("1", "true")
        mode = "native"

        self._participants: dict[str, str] = {}  # identity -> name
        self._pump_tasks: set[asyncio.Task] = set()
        self._pumped: set = set()  # track sids already being pumped
        # C7: a participant can publish MORE than one audio track (a shared tab
        # carries SCREENSHARE_AUDIO next to the microphone). Deduping on the track
        # sid alone let both run: two pumps under one tag/one mixer bucket, i.e.
        # 2x real-time production for that identity. Pumps are therefore keyed by
        # IDENTITY too, and the task is kept so the disconnect can await it (C10).
        self._pump_by_identity: dict[str, asyncio.Task] = {}
        self._track_sids: dict[str, str] = {}  # identity -> audio track sid

        # Republish the Transcriber's captions INTO the room as native LiveKit
        # transcription segments (see bot/captions.py). Requires the join token to
        # carry can_publish_data (Meet mints it so; the dev env-mint below does too).
        self.publish_captions = os.environ.get(
            "VISIOBOT_PUBLISH_NATIVE_SUBS", "true"
        ).strip().lower() in ("1", "true")
        self._captions_published = 0
        self._caption_errors = 0
        self._unattributed_captions = 0
        # One timeline for every ASR connection behind this channel (see captions).
        # Anchored on the bot's OWN join instant (the wall-clock twin of the
        # `self._t0` meeting origin below), not on the first caption that happens
        # to arrive: every sub-ASR of this channel is created lazily on the first
        # tagged frame WE send, so the join is provably no later than any
        # `astart`. Anchoring on the first caption is unsafe in per-stream — a
        # sub-ASR starts on the first VAD-passing frame (a cough is enough) but a
        # caption only exists once the provider recognises TEXT, so a participant
        # present from the start who speaks late can arrive second and clamp
        # every earlier-anchored stream onto 0.
        self._t0_epoch_ms = int(time.time() * 1000)
        self._segment_clock = SegmentClock(anchor_ms=self._t0_epoch_ms)
        # Recently-departed identities, kept for late caption attribution.
        self._departed: dict[str, str] = {}  # identity -> last known name
        self._departed_sids: dict[str, str] = {}  # identity -> last known track sid

        # perStream tagging + VAD gate (no numpy). Tags are a recycled pool over
        # 0..254 (OVERFLOW_TAG=255 is reserved): `_free_tags` is a min-heap of
        # tags returned by departed participants, `_next_tag` is the high-water
        # mark capped at OVERFLOW_TAG so we never wrap past 255 onto live tags.
        self._tags: dict[str, int] = {}  # identity -> stable u8 tag
        self._free_tags: list[int] = []  # min-heap of recycled tags (lowest first)
        self._next_tag = 0
        # C11: identities whose disconnect has been processed. A pump frame that
        # lands after the 'leave' must NOT re-allocate a tag — the Transcriber
        # would lazily recreate the sub-ASR it just tore down, and that one never
        # receives another 'leave'.
        # Insertion-ordered (dict, not set) so the FIFO bound drops the OLDEST.
        self._left: dict[str, bool] = {}
        self._vad_state: dict[str, float] = {}  # identity -> last-active ts (hysteresis)
        self._vad_thr = int(os.environ.get("BOT_VAD_ENERGY_THRESHOLD", "300"))
        self._vad_hangover_s = self._hangover_seconds()
        # Bot-relative meeting clock origin (wall-clock twin: _t0_epoch_ms above,
        # which anchors the caption SegmentClock).
        self._t0 = time.monotonic()
        self._closing = False
        self._failing = False
        # Auto-leave (parity with the web bot): both timers are armed lazily —
        # the join watchdog right after the room join, the empty-meeting timer
        # when the last participant leaves — and cancelled by any join.
        self._has_seen_participant = False
        self._empty_meeting_handle = None
        self._join_watchdog_handle = None
        self._empty_meeting_timeout_s = _env_timeout_seconds(
            "EMPTY_MEETING_TIMEOUT_SECONDS", DEFAULT_EMPTY_MEETING_TIMEOUT_S
        )
        self._join_timeout_s = _env_timeout_seconds(
            "JOIN_TIMEOUT_SECONDS", DEFAULT_JOIN_TIMEOUT_S
        )
        self.on_meeting_empty = None
        self.on_join_timeout = None

        self.room = rtc.Room()
        self.transcriber = TranscriberStream(
            websocket_url,
            diarization_mode=mode,
            per_stream=self.requested_per_stream,
        )
        # The mixer mixes audio AND (mixed mode only) emits native speaker
        # transitions (loudest participant above _vad_thr) carrying the real name.
        # In per-stream it is re-purposed as the ARCHIVE flow — see _align_mixer.
        self.mixer = AudioMixer(
            on_frame=self._on_mixed_frame,
            on_speaker_change=self._on_speaker_change,
            energy_threshold=self._vad_thr,
        )
        # The effective mode can change mid-call (link lost, or a reconnect that
        # landed on another Transcriber and granted differently). The mixer is
        # ours, so we are the ones who have to re-align it.
        self.transcriber.on_mode_change = self._on_transcriber_mode_change
        # The init handshake is re-run on every reconnect and the Transcriber
        # rebuilds its tag -> participant map from the roster it carries, so the
        # stream reads OUR live roster instead of hard-coding an empty list.
        self.transcriber.participants_provider = self._current_roster
        self._mixer_role: str | None = None  # None | "mixed" | "recording"

    def _current_roster(self) -> list:
        """The participants currently in the room, in the init frame's shape.

        Only identities that already hold a tag are listed: `_register_participant`
        allocates one for every join, so this is the whole live roster, and
        `_tags.get()` (not `_tag_for()`) keeps this a pure READ — building an init
        frame must never allocate a tag as a side effect.

        First connect: the room is not joined yet, so this is empty and the roster
        arrives as `participant/join` control messages. Reconnect: this is what
        restores per-participant speaker attribution, which nothing else
        re-announces (`_register_participant` early-returns for a known identity
        and LiveKit fires no new join events for participants already in the room).
        """
        roster = []
        for ident, name in self._participants.items():
            tag = self._tags.get(ident)
            if tag is None:
                continue
            roster.append({"id": ident, "name": name, "tag": tag})
        return roster

    # ---- construction helpers ---------------------------------------------
    @staticmethod
    def _derive_stream_key(websocket_url):
        """`<sessionId>,<channelIndex>` tail of the Transcriber ingest URL.

        The Scheduler builds it as `…/<endpoint>/<sessionId>,<channelIndex>`
        (Scheduler buildTranscriberWsUrl), so the comma is what tells the channel
        token apart from the endpoint path. Returns None when the URL does not
        carry one (nothing then namespaces the segment ids — the pre-existing
        behaviour)."""
        if not isinstance(websocket_url, str):
            return None
        path = websocket_url.split("?", 1)[0].split("#", 1)[0].rstrip("/")
        tail = path.rsplit("/", 1)[-1]
        return tail if "," in tail else None

    @staticmethod
    def _hangover_seconds() -> float:
        try:
            value = int(
                os.environ.get("BOT_VAD_HANGOVER_MS", str(DEFAULT_VAD_HANGOVER_MS))
            )
        except (TypeError, ValueError):
            value = DEFAULT_VAD_HANGOVER_MS
        if value < 0:
            value = DEFAULT_VAD_HANGOVER_MS
        return value / 1000.0

    # ---- token ------------------------------------------------------------
    def _token(self) -> str:
        # Prefer the payload-supplied token (minted by Meet with ITS secret). Only
        # fall back to env-minting when none was provided — the dev path where the
        # bot's LIVEKIT_API_KEY/SECRET coincide with Meet's.
        if self.join_token:
            return self.join_token
        # S2: the identity must be unique per CHANNEL, not per room. A multi-language
        # session runs one bot per channel against the SAME LiveKit room, and LiveKit
        # evicts the older participant when a second one joins with the same
        # identity — the two bots would take turns kicking each other out.
        identity = f"linto-visio-bot-{self.room_name}"
        if self._stream_key:
            identity = f"{identity}-{self._stream_key}"
        return (
            AccessToken(self.api_key, self.api_secret)
            .with_identity(identity)
            .with_name("LinTO")
            .with_grants(
                VideoGrants(
                    room_join=True,
                    room=self.room_name,
                    can_subscribe=True,
                    can_publish=False,
                    # Data-plane only: needed to republish captions as
                    # transcription segments (no audio/video is ever published).
                    can_publish_data=True,
                    hidden=True,
                    # The SFU only relays transcription packets from AGENT-kind
                    # participants (Meet mints its production token the same way).
                    agent=True,
                )
            )
            .to_jwt()
        )

    # ---- perStream tagging / VAD ------------------------------------------
    def _tag_for(self, identity: str):
        """Stable u8 tag per participant identity, drawn from a recycled pool.

        Allocation order: a known identity keeps its tag; otherwise reuse the
        smallest tag freed by a departed participant; otherwise take the next
        fresh tag while one is available (`_next_tag < OVERFLOW_TAG`); when all
        of 0..254 are in use, hand out the shared OVERFLOW_TAG (255). We never
        mask-and-wrap, so a 256th+ concurrent identity can never collide with a
        still-present participant on tag 0,1,…

        Returns None for an identity that has already LEFT (C11): the Transcriber
        tore its sub-ASR down on the 'leave', and a late frame must be dropped
        rather than lazily recreate an ASR nothing will ever close.
        """
        if identity in self._left:
            return None
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
        """Meeting clock in milliseconds since this bot started (u32-safe).

        This is the `meetingTimeMs` every tagged (0x01) and mixed (0x02) frame
        carries: one clock shared by all participants, which is what lets the
        Transcriber rebuild meeting-relative timestamps from the VAD-gated,
        spliced audio each sub-ASR receives."""
        return int((time.monotonic() - self._t0) * 1000) & 0xFFFFFFFF

    def _vad_active(self, identity: str, pcm: bytes) -> bool:
        """Energy VAD on s16le mono PCM, no numpy. RMS compared to the env
        threshold BOT_VAD_ENERGY_THRESHOLD (default 300), with a hangover of
        BOT_VAD_HANGOVER_MS (default 800 ms): a frame stays "active" that long
        after the last frame above threshold, so every burst carries enough
        trailing silence for the provider to close the utterance (C2b)."""
        now = time.monotonic()
        rms = rms_s16le(pcm)
        if rms >= self._vad_thr:
            self._vad_state[identity] = now
            return True
        last = self._vad_state.get(identity)
        return last is not None and (now - last) <= self._vad_hangover_s

    def _on_mixed_frame(self, frame_bytes: bytes) -> None:
        # K2 dual flow: in per-stream the mixer produces the ARCHIVE stream, which
        # rides its own MAGIC (0x02) and carries the meeting clock; the legacy
        # mixed path keeps shipping bare, header-less PCM exactly as before.
        #
        # Routed on the mixer's ROLE, not on `transcriber.per_stream`: a link loss
        # transiently clears the latter, and switching wire shape mid-gap would
        # leave the send queue holding frames the reconnected Transcriber decodes
        # as garbage. The role only moves on a real re-grant (_align_mixer).
        if self._mixer_role == "recording":
            self.transcriber.enqueue_mixed(self._now_ms(), frame_bytes)
        else:
            self.transcriber.enqueue(frame_bytes)

    def _on_speaker_change(self, speaker) -> None:
        # Native diarization transition from the mixer's energy VAD. `speaker` is
        # {"id","name"} (real display name) or None for silence. NOT ack-gated.
        # Never fires in per-stream: the mixer runs with diarization disabled there.
        self.transcriber.send_speaker_change(self._now_ms(), speaker)

    # ---- mixer role -------------------------------------------------------
    def _align_mixer(self) -> None:
        """Put the mixer in the role the CURRENT grant calls for.

        - legacy mixed (no per-stream grant): the mixer IS the transcription
          stream, diarization ON — byte-identical to the pre-per-stream bot;
        - per-stream + mixedRecording granted (K2): the mixer produces the
          ARCHIVE flow only (channel.keepAudio), diarization OFF — the Transcriber
          attributes captions by tag and discards speakerChanged there;
        - per-stream without the grant: the mixer stays idle, exactly as today.
        """
        if self.transcriber.per_stream:
            role = "recording" if self.transcriber.mixed_recording else None
        else:
            role = "mixed"
        if role == self._mixer_role:
            return
        self.mixer.stop()
        if self._mixer_role is not None:
            # Role change mid-call: the buffered audio belongs to the previous
            # role's stream and must not be prepended to the new one.
            self.mixer.clear()
        self._mixer_role = role
        if role is None:
            return
        self.mixer.diarization = role == "mixed"
        self.mixer.start()

    def _on_transcriber_mode_change(self, per_stream: bool) -> None:
        # Fired by TranscriberStream on a real transition of the EFFECTIVE mode.
        # A link LOSS also clears per_stream: that is not a new grant, so leave the
        # mixer alone and let the (bounded) send queue absorb the gap.
        if not self.transcriber.ready:
            return
        print(
            f"LiveKitBot: transcriber mode changed (perStream={per_stream}, "
            f"mixedRecording={self.transcriber.mixed_recording}), realigning the mixer",
            flush=True,
        )
        self._align_mixer()

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

        # 2. Start the 20 ms mixer tick in whichever role the ACK calls for. The
        #    ack was already received inside transcriber.connect() above, so the
        #    grant is final here (before the sweep / any _pump).
        self._align_mixer()

        # 3. Wire room events BEFORE connecting so nothing published between
        #    connect() and the post-connect sweep is missed.
        self.room.on("track_subscribed", self._on_track_subscribed)
        # A track can be unpublished and republished mid-call (mute/unmute on
        # some clients, a device change): the old pump must die and forget its
        # sid, or the republished track is refused for the rest of the call.
        self.room.on("track_unsubscribed", self._on_track_unsubscribed)
        self.room.on("participant_connected", self._on_participant_connected)
        self.room.on("participant_disconnected", self._on_participant_disconnected)
        self.room.on("participant_name_changed", self._on_participant_name_changed)
        # A terminated LiveKit session (room deleted, participant removed, SFU
        # gone) otherwise leaves a bot that holds a Transcriber socket and its
        # pumps forever while the room is dead.
        self.room.on("disconnected", self._on_room_disconnected)

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

        # 5. Sweep participants/tracks already present at connect time. Room.connect
        #    builds RemoteTrackPublications with no track attached, so `pub.track`
        #    is normally None here and the pump starts from track_subscribed (wired
        #    above, so nothing is missed); the sweep still registers the roster and
        #    covers an SDK/publication that already carries the track.
        for participant in self.room.remote_participants.values():
            self._sweep_participant(participant)

        # 6. Auto-leave: nobody in the room yet -> arm the absolute join watchdog
        #    (the sweep above already cancelled it if someone was there).
        self._arm_join_watchdog()

        return True

    def _sweep_participant(self, participant) -> None:
        """Register a participant already in the room and pump any audio track
        its publication already carries."""
        self._register_participant(participant)
        identity = participant.identity
        for pub in participant.track_publications.values():
            track = getattr(pub, "track", None)
            if track is None or not self._is_audio(track):
                continue
            # C7: the publication object the sweep iterates is exactly where
            # `.source` lives — screenshare audio must not be pumped.
            if not self._is_microphone(pub):
                continue
            self._start_pump(track, identity)

    # ---- track selection ---------------------------------------------------
    @staticmethod
    def _is_audio(track) -> bool:
        return getattr(track, "kind", None) == rtc.TrackKind.KIND_AUDIO

    @staticmethod
    def _is_microphone(publication) -> bool:
        """C7: keep only the participant's MICROPHONE audio publication.

        `track.kind` says audio-vs-video; the microphone/screen-share distinction
        lives in a separate enum exposed as `RemoteTrackPublication.source`. A
        participant sharing a tab with sound publishes SCREENSHARE_AUDIO next to
        their microphone, and pumping both doubles that identity's production
        rate (one tag / one mixer bucket, two producers).

        SOURCE_UNKNOWN is admitted: a client that publishes a track without
        declaring a source still means "microphone", and rejecting it would drop
        that participant's audio entirely — a far worse regression than the
        screenshare case this guards. Screenshare sources are what we exclude.
        """
        source = getattr(publication, "source", None)
        sources = getattr(rtc, "TrackSource", None)
        microphone = getattr(sources, "SOURCE_MICROPHONE", None)
        if source is None or microphone is None:
            return True  # SDK without the enum: keep the legacy kind-only gate
        unknown = getattr(sources, "SOURCE_UNKNOWN", None)
        return source == microphone or (unknown is not None and source == unknown)

    # ---- event handlers (sync paho-style callbacks from the SDK) ----------
    def _on_track_subscribed(self, track, publication, participant) -> None:
        if not self._is_audio(track) or not self._is_microphone(publication):
            return
        self._start_pump(track, participant.identity)

    def _on_participant_connected(self, participant) -> None:
        self._register_participant(participant)

    def _on_participant_disconnected(self, participant) -> None:
        ident = participant.identity
        name = self._participants.pop(ident, None)
        # C11: the disconnect is AUTHORITATIVE from here on — a pump frame that
        # lands after it finds no tag and is dropped, instead of re-creating the
        # sub-ASR the 'leave' is about to tear down.
        self._left[ident] = True
        while len(self._left) > LEFT_MAX:
            self._left.pop(next(iter(self._left)), None)
        # Forget this participant's audio track sid on BOTH maps so `_pumped`
        # does not grow unbounded over a long call with high participant churn.
        sid = self._track_sids.pop(ident, None)
        if sid is not None:
            self._pumped.discard(sid)
        # Keep the identity attributable for a while: a final routinely lands
        # after its speaker hung up, and the bot is HIDDEN, so falling back to the
        # bot identity would hide those last words from the overlay.
        if name is not None:
            self._remember_departed(ident, name, sid)
        # Drop the mixer state too so a departed participant can't stay the
        # "current speaker" (no-op when the mixer is idle in perStream).
        self.mixer.remove_participant(ident)
        # …and the VAD hysteresis, like every sibling map.
        self._vad_state.pop(ident, None)
        # Recycle the tag back to the pool so a later joiner reuses a low tag
        # instead of pushing _next_tag toward OVERFLOW_TAG. This is what lets the
        # Transcriber's per-participant 'leave' teardown actually free an ASR
        # slot. OVERFLOW_TAG is shared and never owned by a single identity, so
        # it is dropped rather than recycled.
        tag = self._tags.pop(ident, None)
        if name is not None:
            self.transcriber.send_participant("leave", ident, name, tag)
        # C10: the tag may only go back into the pool once this participant's pump
        # is DEAD. Recycling it while the pump is still draining its stream would
        # hand a live producer's tag to the next joiner, mixing two participants
        # into one sub-ASR.
        self._retire_pump(ident, tag)
        # Auto-leave: was that the last one?
        self._check_empty_meeting()

    def _remember_departed(self, ident: str, name: str, sid) -> None:
        self._departed[ident] = name
        if isinstance(sid, str) and sid:
            self._departed_sids[ident] = sid
        while len(self._departed) > DEPARTED_MAX:
            oldest = next(iter(self._departed))
            self._departed.pop(oldest, None)
            self._departed_sids.pop(oldest, None)

    def _retire_pump(self, ident: str, tag) -> None:
        """Stop this identity's pump, THEN release its tag (C10)."""
        task = self._pump_by_identity.pop(ident, None)
        if task is None or task.done():
            self._release_tag(tag)
            return
        task.cancel()
        try:
            teardown = asyncio.create_task(self._await_pump(task, tag))
        except RuntimeError:
            # No running loop (never in the SDK callback path, only in a direct
            # synchronous call): the pump is cancelled, release the tag now.
            self._release_tag(tag)
            return
        self._pump_tasks.add(teardown)
        teardown.add_done_callback(self._pump_tasks.discard)

    async def _await_pump(self, task, tag) -> None:
        # return_exceptions keeps a cancelled/raising pump from swallowing the
        # tag release (and never re-raises the child's CancelledError as ours).
        await asyncio.gather(task, return_exceptions=True)
        self._release_tag(tag)

    def _release_tag(self, tag) -> None:
        if tag is not None and tag != OVERFLOW_TAG:
            heapq.heappush(self._free_tags, tag)

    # ---- auto-leave (parity with BotService/bot/index.js) -------------------
    def _cancel_timer(self, attr: str) -> None:
        _cancel_handle(self, attr)

    def _call_later(self, delay_s: float, callback):
        """Schedule `callback` on the running loop; None when there is no loop
        (a direct synchronous call outside the service, never the SDK path)."""
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return None
        return loop.call_later(delay_s, callback)

    def _check_empty_meeting(self) -> None:
        """Arm the empty-meeting timer once the LAST participant has left — only
        after somebody was seen (an empty room at join is the watchdog's job)."""
        if self._closing or self._failing:
            return
        if not self._has_seen_participant or self._participants:
            return
        if self._empty_meeting_handle is not None:
            return
        print(
            f"LiveKitBot: room={self.room_name} is empty, auto-leave in "
            f"{self._empty_meeting_timeout_s:g}s",
            flush=True,
        )
        self._empty_meeting_handle = self._call_later(
            self._empty_meeting_timeout_s, self._on_empty_meeting_timer
        )

    def _on_empty_meeting_timer(self) -> None:
        self._empty_meeting_handle = None
        # Re-check: a join that raced the timer already disarmed it, but be safe.
        if self._closing or self._failing or self._participants:
            return
        print(
            f"LiveKitBot: room={self.room_name} still empty after "
            f"{self._empty_meeting_timeout_s:g}s — leaving (meeting over)",
            flush=True,
        )
        self._spawn_leave("meeting-empty")

    def _arm_join_watchdog(self) -> None:
        """Absolute watchdog: nobody seen after the join -> leave as a FAILURE."""
        if self._has_seen_participant or self._join_watchdog_handle is not None:
            return
        if self._closing or self._failing:
            return
        self._join_watchdog_handle = self._call_later(
            self._join_timeout_s, self._on_join_watchdog_timer
        )

    def _on_join_watchdog_timer(self) -> None:
        self._join_watchdog_handle = None
        if self._closing or self._failing or self._has_seen_participant:
            return
        print(
            f"LiveKitBot: join watchdog fired — no participant within "
            f"{self._join_timeout_s:g}s in room={self.room_name} (wrong room / "
            "empty room), leaving",
            flush=True,
        )
        self._spawn_leave("join-timeout")

    def _spawn_leave(self, kind: str) -> None:
        # Both timers fire on the loop thread (call_later), so a task can be
        # created directly; the RuntimeError guard mirrors _on_room_disconnected.
        if self._closing or self._failing:
            return
        # Latch: from here on the bot is on its way out. `_failing` also makes a
        # concurrent room 'disconnected' (our own dispose emits it) a no-op.
        self._failing = True
        try:
            asyncio.create_task(self._leave(kind))
        except RuntimeError:  # no running loop
            pass

    async def _leave(self, kind: str) -> None:
        """Hand the leave to the owner (BrokerClient asks the Scheduler to end /
        clean the session, then stops us); with no owner, dispose ourselves."""
        hook = self.on_meeting_empty if kind == "meeting-empty" else self.on_join_timeout
        if hook is None:
            await self.dispose()
            return
        try:
            result = hook()
            if asyncio.iscoroutine(result) or isinstance(result, asyncio.Future):
                await result
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            print(f"LiveKitBot: {kind} hook raised: {e}", flush=True)
            await self.dispose()

    def _on_track_unsubscribed(self, track, publication, participant) -> None:
        """The SDK dropped a track (unpublish, republish, device change). Stop
        its pump and forget its sid so the SAME sid — or a new one for the same
        identity — can be pumped again. The tag is untouched: the participant is
        still in the room, and a sub-ASR keyed by tag stays theirs."""
        sid = getattr(track, "sid", None) or id(track)
        identity = getattr(participant, "identity", None)
        self._pumped.discard(sid)
        if identity is None:
            return
        if self._track_sids.get(identity) != sid:
            return  # not the track this identity's pump is reading
        task = self._pump_by_identity.pop(identity, None)
        if task is not None and not task.done():
            task.cancel()

    def _on_room_disconnected(self, *args) -> None:
        """The LiveKit session ended under us (room deleted, bot removed, SFU
        gone). Without this the bot is a zombie: no audio will ever arrive again,
        yet it holds a Transcriber socket, its pumps and a slot in activeBots."""
        if self._closing or self._failing:
            return  # our own dispose() also emits this event
        self._failing = True
        reason = args[0] if args else "unknown"
        print(
            f"LiveKitBot: room {self.room_name} disconnected ({reason}) — "
            "tearing the bot down",
            flush=True,
        )
        try:
            asyncio.create_task(self._fail("livekit-disconnected"))
        except RuntimeError:  # no running loop (never in the SDK callback path)
            pass

    async def _fail(self, reason: str) -> None:
        """Report a fatal room-side failure through the owner's failure hook.

        BrokerClient wires that hook on the transcriber stream (publish
        bot-error + stop_bot, which disposes us); with no owner we can at least
        release our own resources."""
        callback = getattr(self.transcriber, "on_failure", None)
        if callback is None:
            await self.dispose()
            return
        try:
            result = callback(reason)
            if asyncio.iscoroutine(result) or isinstance(result, asyncio.Future):
                await result
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            print(f"LiveKitBot: on_failure({reason}) raised: {e}", flush=True)
            await self.dispose()

    def _on_participant_name_changed(self, *args) -> None:
        # BONUS: the LiveKit display name can change mid-call (rename). Refresh
        # the memorised name so subsequent captions use it.
        #
        # The positional order of this event has changed across livekit-rtc
        # releases (1.1.12 emits `(participant, old_name)`, older builds emitted
        # the value first). Pick whichever arg exposes `.identity` instead of
        # assuming a position, so an SDK bump cannot silently break renames.
        participant = next(
            (a for a in args if getattr(a, "identity", None) is not None), None
        )
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
        # perStream: the mixer is idle (or archiving), so emit an explicit
        # 'rename' control message — the Transcriber's already-created sub-ASR is
        # keyed by tag and updates its display name live. Without this the sub-ASR
        # would keep the old name for the rest of the call.
        #
        # Gated on the mixer's ROLE like the two producer call sites
        # (_on_mixed_frame, _pump), NOT on `transcriber.per_stream`: that is a
        # LINK-state flag which a socket close clears for the whole reconnect
        # window, and reconnects are routine (pod restart, LB re-route —
        # doc/production-topology.md). A rename landing in that gap was dropped and
        # never retried, since line 589 above already recorded the new name and
        # every later identical event early-returns. The frame is queued as
        # _KIND_CONTROL, which the bounded queue never drops and clear_audio()
        # explicitly keeps, so it simply rides out the gap and is flushed once the
        # replacement link is ack'd.
        if self._mixer_role != "mixed":
            tag = self._tag_for(ident)
            if tag is not None:
                self.transcriber.send_participant("rename", ident, name, tag)

    def _register_participant(self, participant) -> None:
        ident = participant.identity
        # Auto-leave: somebody is (still) here. Latch the "admitted" milestone
        # and disarm both timers — before the known-identity early return, so a
        # duplicate event can never leave a timer running on a populated room.
        if not self._has_seen_participant:
            print(
                f"LiveKitBot: first participant seen in room={self.room_name} "
                f"({getattr(participant, 'name', None) or ident})",
                flush=True,
            )
        self._has_seen_participant = True
        self._cancel_timer("_join_watchdog_handle")
        self._cancel_timer("_empty_meeting_handle")
        if ident in self._participants:
            return
        # A re-join of the same identity is a NEW participant: lift the C11 block
        # so it can be tagged again.
        self._left.pop(ident, None)
        self._departed.pop(ident, None)
        self._departed_sids.pop(ident, None)
        name = getattr(participant, "name", None) or ident
        self._participants[ident] = name
        self.transcriber.send_participant("join", ident, name, self._tag_for(ident))

    # ---- captions -> LiveKit transcription segments ------------------------
    async def publish_caption(self, payload: dict, kind: str, is_translation: bool) -> None:
        """Republish one Transcriber caption into the room as a transcription
        segment attributed to the speaking participant (see bot/captions.py).

        Best-effort: a mapping miss or an SDK error is logged and dropped — the
        Transcriber/Studio pipeline is unaffected, only the in-room overlay is.
        """
        if not self.publish_captions:
            return
        mapped = caption_to_segment(
            payload,
            kind,
            is_translation,
            # Namespace the id per CHANNEL: two channels of one session share this
            # LiveKit room and their segmentIds both start at 1.
            channel_key=self._stream_key,
            # ONE timeline across every ASR connection behind this channel — in
            # per-stream TOO. The Transcriber's per-sub-ASR timeline map does NOT
            # publish meeting-ABSOLUTE offsets: it is seeded at that sub-ASR's
            # FIRST frame (cumulativeGapMs starts at 0 and the first frame's
            # meetingTimeMs is deliberately discarded — ASR/index.js
            # _noteMeetingTime), and _applyTimeline only ADDS BACK the silence the
            # bot's own VAD gate elided; it never re-origins. So the offsets stay
            # anchored on that sub-ASR's own `astart`, exactly like every legacy
            # caption, and the meeting-wide anchoring is the CONSUMER's job —
            # Session-API rebases with (astart - MIN(astart)) + start, and this
            # clock is the in-room overlay's equivalent of that rebase.
            # Exempting per-stream collapsed every speaker onto the meeting start:
            # a participant who first spoke five minutes in was captioned at 0 ms.
            clock=self._segment_clock,
            meeting_relative=False,
        )
        if mapped is None:
            return
        segment_id, text, start_ms, end_ms, language, final = mapped
        # `room.local_participant` RAISES before the room is connected — it never
        # returns None, so the old `getattr(..., None)` guard was dead code.
        try:
            local = self.room.local_participant
        except Exception:  # noqa: BLE001
            return
        identity = resolve_speaker(
            payload, self._participants, local.identity, departed=self._departed
        )
        track_sid = self._track_sids.get(identity) or self._departed_sids.get(
            identity, ""
        )
        if identity == local.identity:
            # Nothing mapped this caption to a real participant (the shared
            # overflow bucket, or a speaker we never saw): it is published under
            # the bot's own HIDDEN identity with no track, which most clients
            # cannot render. Say so once rather than losing it silently.
            self._unattributed_captions += 1
            if self._unattributed_captions == 1:
                print(
                    "LiveKitBot: WARNING — caption could not be attributed to a "
                    f"room participant (locutor={payload.get('locutor')!r}); it is "
                    "published under the bot's hidden identity and may not render",
                    flush=True,
                )
        try:
            await local.publish_transcription(
                rtc.Transcription(
                    participant_identity=identity,
                    track_sid=track_sid,
                    segments=[
                        rtc.TranscriptionSegment(
                            id=segment_id,
                            text=text,
                            start_time=start_ms,
                            end_time=end_ms,
                            language=language,
                            final=final,
                        )
                    ],
                )
            )
            self._captions_published += 1
            if self._captions_published == 1:
                print(
                    f"LiveKitBot: first caption republished into room={self.room_name} "
                    f"(speaker={identity})",
                    flush=True,
                )
        except Exception as e:  # noqa: BLE001 — never let a caption kill the bot
            # Throttled: a broken data channel fails on EVERY caption, several per
            # second, for the rest of the call.
            self._caption_errors += 1
            if (
                self._caption_errors == 1
                or self._caption_errors % CAPTION_ERROR_WARN_EVERY == 0
            ):
                print(
                    f"LiveKitBot: publish_transcription failed "
                    f"({self._caption_errors} so far): {e}",
                    flush=True,
                )

    def _start_pump(self, track, identity: str) -> None:
        sid = getattr(track, "sid", None) or id(track)
        # C7: one pump per TRACK *and* one per IDENTITY. Two concurrent pumps for
        # one identity share a tag (per-stream) or a mixer bucket (mixed), so they
        # produce at 2x real time and that participant falls monotonically behind.
        if sid in self._pumped:
            return
        if identity in self._left:
            return
        # C7, first wins: a SECOND audio track for an identity whose pump is still
        # alive is refused (a source-less client publishing its microphone and a
        # screenshare audio would otherwise take turns). A republish is not this
        # case: the SDK unsubscribes the old track first, and
        # _on_track_unsubscribed drops the identity's entry SYNCHRONOUSLY — it
        # does not wait for the old task to drain its EOS — so the new track's
        # `track_subscribed` lands on a free identity and is pumped.
        old = self._pump_by_identity.get(identity)
        if old is not None and not old.done():
            return
        self._pumped.add(sid)
        # Remember the participant's audio track so republished captions can be
        # attributed to the exact track (LiveKit `Transcription.track_sid`).
        if isinstance(sid, str):
            self._track_sids[identity] = sid
        task = asyncio.create_task(self._pump(track, identity))
        self._pump_by_identity[identity] = task
        self._pump_tasks.add(task)
        task.add_done_callback(self._pump_tasks.discard)

    async def _pump(self, track, identity: str) -> None:
        # rtc.AudioStream already resamples to 16 kHz mono s16le — just relay
        # ev.frame.data bytes to the mixer (no numpy, no manual resample).
        sid = getattr(track, "sid", None) or id(track)
        stream = rtc.AudioStream(track, sample_rate=16000, num_channels=1)
        try:
            async for ev in stream:
                data = ev.frame.data
                pcm = data.tobytes() if hasattr(data, "tobytes") else bytes(data)
                # The mixer's ROLE is the producer-side source of truth for the
                # mode (see _on_mixed_frame): it only moves on a real re-grant.
                if self._mixer_role == "mixed":
                    # Mixed: feed the mixer with the display name so the energy
                    # VAD can emit speakerChanged carrying the real name.
                    self.mixer.push(identity, pcm, self._participants.get(identity))
                    continue
                # K2 dual flow: the ARCHIVE gets EVERY frame, UN-GATED and
                # BEFORE the VAD gate — channel.keepAudio must record the
                # sub-threshold audio exactly like the legacy recording does.
                if self._mixer_role == "recording":
                    self.mixer.push(identity, pcm, self._participants.get(identity))
                # perStream: VAD-gate then ship the frame tagged. Silence
                # produces no frame (no ASR, no worker).
                if self._vad_active(identity, pcm):
                    tag = self._tag_for(identity)
                    if tag is not None:
                        self.transcriber.enqueue_tagged(tag, self._now_ms(), pcm)
        except asyncio.CancelledError:
            pass
        except Exception as e:  # noqa: BLE001
            # Never let a pump kill the bot, but never lose the reason either: a
            # silent death here looks exactly like a participant who stopped
            # talking. The sid is forgotten below, so a republish restarts it.
            print(
                f"LiveKitBot: audio pump for {identity} (sid {sid}) died: {e!r}",
                flush=True,
            )
        finally:
            # Only ever clear OUR OWN entry: a re-join of the same identity may
            # already have registered a replacement pump here.
            if self._pump_by_identity.get(identity) is asyncio.current_task():
                self._pump_by_identity.pop(identity, None)
            # The sid dedup only guards a LIVE pump; a dead one must not pin the
            # sid forever (that leaked one entry per unpublish/republish cycle and
            # refused the same sid if the SDK ever re-delivered it).
            self._pumped.discard(sid)
            try:
                await stream.aclose()
            except Exception:  # noqa: BLE001
                pass

    async def dispose(self) -> None:
        self._closing = True
        # Auto-leave timers must not outlive the bot (a late fire on a disposed
        # bot would call the owner hook for a key somebody else may own now).
        _cancel_handle(self, "_join_watchdog_handle")
        _cancel_handle(self, "_empty_meeting_handle")
        for task in list(self._pump_tasks):
            task.cancel()
        self._pump_tasks.clear()
        self._pump_by_identity.clear()
        try:
            await self.room.disconnect()
        except Exception:  # noqa: BLE001
            pass
        try:
            await self.transcriber.close()
        except Exception:  # noqa: BLE001
            pass
        self.mixer.stop()
