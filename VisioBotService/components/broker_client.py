"""BrokerClient — the single MQTT-driven component of visio-bot-service.

Mirrors BotService/components/BrokerClient/index.js but for the NATIVE LiveKit
path: no BrowserPool / LocalAudioServer, the bot is a server-SDK rtc.Room hidden
participant (see bot/livekit_bot.py).

Topics (same convention as the web BotService, so the Scheduler routes to both):
  out  botservice/out/<uniqueId>/status   {uniqueId, online, activeBots, rss, capabilities, metrics}
  in   botservice/in/<uniqueId>/startbot  {session, channel, websocketUrl, botId, ...}
  in   botservice/in/<uniqueId>/stopbot   {sessionId, channelId}

The uniqueId is prefixed `visio-bot-service-` (the web bot is `botservice-`) so
the Scheduler can tell the two replica families apart; this replica advertises
the `visio-native` capability.
"""
import asyncio
import ipaddress
import json
import os
import resource
import uuid
from urllib.parse import urlsplit

import paho.mqtt.client as mqtt

from bot.captions import topic_kind
from bot.livekit_bot import LiveKitBot

HEARTBEAT_S = 15

# Schemes the LiveKit client dials. Anything else (http(s), file:, gopher:, …) is
# refused outright rather than handed to the SDK.
LIVEKIT_SCHEMES = ("ws", "wss")

# Hostnames (DNS names, not IP literals) that obviously resolve to loopback. As in
# the Session-API guard we deliberately do NOT resolve DNS in this path.
LOCALHOST_NAMES = frozenset(
    {"localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback"}
)


def _is_forbidden_host(host: str) -> bool:
    """True when `host` is an obvious loopback name or a reserved/private IP."""
    lowered = host.lower().strip("[]").split("%", 1)[0]  # drop brackets + zone id
    if lowered in LOCALHOST_NAMES or lowered.endswith(".localhost"):
        return True
    try:
        ip = ipaddress.ip_address(lowered)
    except ValueError:
        return False  # a DNS name — scheme/localhost checks only, no resolution
    if ip.version == 6 and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped  # ::ffff:127.0.0.1 must classify as the IPv4 it maps to
    return (
        ip.is_loopback
        or ip.is_private
        or ip.is_link_local  # incl. cloud metadata 169.254.169.254
        or ip.is_reserved
        or ip.is_unspecified
        or ip.is_multicast
    )


def validate_livekit_url(url, allowed_hosts=(), allow_private=False):
    """SSRF guard for the livekitUrl carried in CLIENT-WRITABLE session meta.

    The bot dials this URL from inside the cluster, so whoever can write
    `session.meta.native[...]` could otherwise aim it at loopback, link-local
    (169.254.169.254) or RFC1918 targets. This mirrors validateBotUrl() in
    Session-API/components/WebServer/routes/api/bots.helpers.js — the guard the
    sibling WEB bot path already has — adapted to the ws/wss schemes LiveKit uses.

    Fails CLOSED: returns a reason string for anything unparseable, non-ws,
    hostless, or pointing at a reserved/private target; None when acceptable.

    `allowed_hosts` (VISIOBOT_LIVEKIT_ALLOWED_HOSTS) is an explicit operator
    accept-list: when set it is the ONLY thing accepted, and a listed host is
    admitted even if it is private (that is the point of listing it).
    `allow_private` (DEVELOPMENT) re-admits loopback/private SFUs for local runs.
    """
    if not isinstance(url, str) or not url.strip():
        return "livekitUrl must be a non-empty string"
    try:
        parsed = urlsplit(url.strip())
    except ValueError as e:
        return f"livekitUrl is not a valid URL ({e})"
    if parsed.scheme.lower() not in LIVEKIT_SCHEMES:
        return f"livekitUrl scheme must be one of {'/'.join(LIVEKIT_SCHEMES)}"
    try:
        host = parsed.hostname  # drops the port, unwraps an IPv6 literal
    except ValueError as e:
        return f"livekitUrl has an invalid host ({e})"
    if not host:
        return "livekitUrl must have a host"
    if allowed_hosts:
        if host.lower() in allowed_hosts:
            return None
        return "livekitUrl host is not in VISIOBOT_LIVEKIT_ALLOWED_HOSTS"
    if _is_forbidden_host(host) and not allow_private:
        return "livekitUrl host points at a loopback/reserved/private address"
    return None


class BrokerClient:
    def __init__(self) -> None:
        self.unique_id = f"visio-bot-service-{uuid.uuid4()}"
        self.pub = f"botservice/out/{self.unique_id}"
        self.sub = f"botservice/in/{self.unique_id}/#"
        self.capabilities = [
            c.strip()
            for c in os.environ.get("BOT_CAPABILITIES", "visio-native").split(",")
            if c.strip()
        ]
        self.broker_host = os.environ.get("BROKER_HOST", "mosquitto")
        self.broker_port = int(os.environ.get("BROKER_PORT", "1883"))
        # When true, the join token MUST come from the startbot payload (Meet-minted,
        # per-room). The bot never env-mints in this mode — a missing token fails
        # closed (bot-error) rather than signing a devkey against a real LiveKit.
        # Default false keeps the dev env-mint path (coinciding devkey/secret).
        self.token_from_payload = (
            os.environ.get("LIVEKIT_TOKEN_FROM_PAYLOAD", "false").strip().lower()
            in ("1", "true")
        )

        # SSRF guard inputs for the client-writable livekitUrl: an explicit host
        # accept-list (authoritative when set) and a DEVELOPMENT escape hatch that
        # re-admits the loopback/private SFU of a local stack.
        self.livekit_allowed_hosts = frozenset(
            h.strip().lower()
            for h in os.environ.get("VISIOBOT_LIVEKIT_ALLOWED_HOSTS", "").split(",")
            if h.strip()
        )
        self.livekit_allow_private = os.environ.get(
            "DEVELOPMENT", ""
        ).strip().lower() in ("1", "true")

        self.bots: dict[str, LiveKitBot] = {}  # `${sessionId}_${channelId}` -> LiveKitBot
        # K5: key reservations held for the whole of an in-flight start_bot. The
        # bot only becomes visible in `bots` once started, so without this a
        # 'stopbot' arriving during the (slow) start would find nothing to pop and
        # the bot would go on to join the room untracked and never disposed.
        self._starting: dict[str, object] = {}
        # Per-bot caption subscription topics, kept so they can be RE-issued when
        # paho reconnects (a reconnect starts a clean session and forgets them).
        self._caption_subs: dict[str, str] = {}
        self.loop: asyncio.AbstractEventLoop | None = None
        self.client: mqtt.Client | None = None
        self._stopping: asyncio.Event | None = None

    # ---- status -----------------------------------------------------------
    def _rss_bytes(self) -> int:
        # CURRENT resident set, in bytes, to match the web BotService's
        # process.memoryUsage().rss (the Scheduler uses it as a load tiebreaker).
        # /proc/self/statm field 2 is the resident page count; ru_maxrss is only
        # the fallback because it is the PEAK — it never goes down, so a replica
        # that once hosted a big meeting would look loaded for its whole life.
        try:
            with open("/proc/self/statm", "r", encoding="ascii") as f:
                resident_pages = int(f.read().split()[1])
            return resident_pages * (os.sysconf("SC_PAGE_SIZE") or 4096)
        except Exception:  # noqa: BLE001 — not Linux, or /proc unavailable
            pass
        try:
            return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024
        except Exception:  # noqa: BLE001
            return 0

    def _status(self, online: bool) -> dict:
        rss = self._rss_bytes()
        return {
            "uniqueId": self.unique_id,
            "online": online,
            "activeBots": len(self.bots),
            "rss": rss,
            "heapUsed": rss,
            "metrics": {},
            # Advertise capabilities only while online; an offline/LWT status
            # advertises none so the Scheduler stops routing to us.
            "capabilities": self.capabilities if online else [],
        }

    def _publish_status(self, online: bool) -> None:
        if self.client is None:
            return
        # client.publish is thread-safe in paho, callable from the asyncio loop.
        self.client.publish(
            f"{self.pub}/status", json.dumps(self._status(online)), qos=1, retain=True
        )

    def _publish_bot_error(self, bot_id, reason: str) -> None:
        if not isinstance(bot_id, int) or bot_id <= 0:
            # No addressable botId to publish under — but the failure must not
            # vanish silently (e.g. a fail-closed startbot with no botId): surface
            # it in the logs so it stays observable.
            print(
                f"visio-bot-service: bot-error '{reason}' dropped — "
                f"missing/invalid botId {bot_id!r}",
                flush=True,
            )
            return
        if self.client is None:
            return
        self.client.publish(
            f"botservice/out/{bot_id}/bot-error",
            json.dumps({"botId": bot_id, "reason": reason}),
            qos=1,
            retain=False,
        )

    # ---- lifecycle --------------------------------------------------------
    async def run(self) -> None:
        # CRITICAL: capture the running loop BEFORE connect()/loop_start() — paho
        # fires _on_message on its own network thread and must hand coroutines
        # back to THIS loop via run_coroutine_threadsafe.
        self.loop = asyncio.get_running_loop()
        self._stopping = asyncio.Event()

        self.client = mqtt.Client(
            mqtt.CallbackAPIVersion.VERSION2, client_id=self.unique_id
        )
        self.client.on_connect = self._on_connect
        self.client.on_message = self._on_message
        # Last Will: if we drop off the broker, our retained status flips offline.
        self.client.will_set(
            f"{self.pub}/status", json.dumps(self._status(False)), qos=1, retain=True
        )
        # connect_async + loop_start: the paho network thread waits for the broker
        # to come up (wait-for-broker) and transparently reconnects afterwards, so
        # a broker that is not yet listening at boot no longer crashes the process.
        # Status is (re)published from _on_connect, so nothing is lost across retries.
        self.client.reconnect_delay_set(min_delay=1, max_delay=HEARTBEAT_S)
        self.client.connect_async(self.broker_host, self.broker_port)
        self.client.loop_start()

        print(
            f"visio-bot-service {self.unique_id} starting "
            f"(broker={self.broker_host}:{self.broker_port}, "
            f"capabilities={self.capabilities})",
            flush=True,
        )

        # Heartbeat until asked to stop; the wait is interruptible so shutdown()
        # is honoured immediately instead of after a full HEARTBEAT_S sleep.
        while not self._stopping.is_set():
            self._publish_status(True)
            try:
                await asyncio.wait_for(self._stopping.wait(), timeout=HEARTBEAT_S)
            except asyncio.TimeoutError:
                pass

    async def shutdown(self) -> None:
        """Graceful stop: dispose every live bot, flip status offline, drop MQTT.

        Called from the service's signal handler (SIGTERM/SIGINT). Without this the
        container would only rely on the MQTT Last Will, which the broker publishes
        after the keepalive timeout — leaving the Scheduler routing to a dead
        replica and the LiveKit rooms/transcriber WS torn down uncleanly.
        """
        if self._stopping is not None:
            self._stopping.set()

        # Revoke every in-flight start (K5) so a bot that finishes joining during
        # the shutdown disposes itself instead of surviving as an orphan.
        self._starting.clear()

        # Dispose bots first: leaves the LiveKit rooms and closes the transcriber
        # WebSockets cleanly before we go offline on the broker.
        self._caption_subs.clear()
        for key in list(self.bots.keys()):
            bot = self.bots.pop(key, None)
            if bot is None:
                continue
            try:
                await bot.dispose()
            except Exception as e:  # noqa: BLE001
                print(f"visio-bot-service: dispose {key} on shutdown: {e}", flush=True)

        # Publish an explicit retained offline status (do not wait for the LWT),
        # then disconnect and stop the network thread.
        if self.client is not None:
            self._publish_status(False)
            try:
                self.client.disconnect()
            except Exception:  # noqa: BLE001
                pass
            self.client.loop_stop()
        print("visio-bot-service: shutdown complete", flush=True)

    def _on_connect(self, client, userdata, flags, reason_code, properties) -> None:
        client.subscribe(self.sub, qos=1)
        # Re-issue the per-bot caption subscriptions. paho reconnects with a CLEAN
        # session, so every subscribe() made at startBot time is gone: without this
        # the in-room caption republishing stops PERMANENTLY after any broker blip
        # while the bot happily keeps streaming audio.
        for topic in list(self._caption_subs.values()):
            client.subscribe(topic, qos=0)
        self._publish_status(True)
        print(
            f"visio-bot-service: connected, subscribed to {self.sub} "
            f"(+{len(self._caption_subs)} caption topic(s))",
            flush=True,
        )

    def _on_message(self, client, userdata, msg) -> None:
        # Runs on the paho network thread — never touch asyncio state directly,
        # dispatch every coroutine back onto self.loop.
        #
        # NOTHING may escape this callback. paho 2.x re-raises a callback
        # exception out of its network loop (`suppress_exceptions` is False by
        # default) and its thread then EXITS: the replica keeps heartbeating into
        # a dead client, the healthcheck stays green, and the Scheduler only
        # notices at the LWT keepalive. One malformed payload (`null`, a list, a
        # string — all valid JSON) must therefore be logged and dropped, never
        # allowed to take the whole replica off the broker.
        try:
            self._dispatch_message(msg)
        except Exception as e:  # noqa: BLE001
            topic = getattr(msg, "topic", "?")
            print(f"visio-bot-service: error handling MQTT message on {topic}: {e!r}", flush=True)

    def _dispatch_message(self, msg) -> None:
        try:
            parts = msg.topic.split("/")
            action = parts[3] if len(parts) > 3 else None
            data = json.loads(msg.payload.decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            print(f"visio-bot-service: malformed MQTT message on {msg.topic}: {e}", flush=True)
            return
        # Every payload this service consumes is a JSON OBJECT; anything else is
        # malformed even though json.loads accepted it.
        if not isinstance(data, dict):
            print(
                f"visio-bot-service: malformed MQTT message on {msg.topic}: "
                f"expected a JSON object, got {type(data).__name__}",
                flush=True,
            )
            return

        if self.loop is None:
            return

        # Transcriber captions for a session/channel this replica serves: hand
        # them to the bot so it republishes them into the LiveKit room.
        if parts[0] == "transcriber":
            caption = topic_kind(msg.topic)
            if caption is None:
                return
            session_id, channel_id, kind, is_translation = caption
            bot = self.bots.get(f"{session_id}_{channel_id}")
            if bot is not None:
                asyncio.run_coroutine_threadsafe(
                    bot.publish_caption(data, kind, is_translation), self.loop
                )
            return

        if action == "startbot":
            asyncio.run_coroutine_threadsafe(self.start_bot(data), self.loop)
        elif action == "stopbot":
            asyncio.run_coroutine_threadsafe(
                self.stop_bot(data.get("sessionId"), data.get("channelId")), self.loop
            )

    # ---- bot management ---------------------------------------------------
    async def start_bot(self, data: dict) -> None:
        try:
            session = data["session"]
            channel = data["channel"]
            session_id = session["id"]
            channel_id = channel["id"]
        except (KeyError, TypeError) as e:
            print(f"visio-bot-service: invalid startbot payload: {e}", flush=True)
            return

        key = f"{session_id}_{channel_id}"
        bot_id = data.get("botId")

        # K5: reserve the key FIRST — synchronously, before the very first await
        # of this coroutine — so everything that follows can tell whether it is
        # still the owner. A stopbot (or a newer startbot) arriving at ANY point
        # of the start, including while the predecessor below is still disposing,
        # takes this token from us; we then bail out / dispose the orphan instead
        # of leaving a bot in the room that nothing tracks. Reserving only after
        # the teardown await left exactly that window open: a stop landing during
        # the predecessor's dispose found neither a reservation nor a bot, and the
        # replacement then started with no row and no owner left to stop it.
        token = object()
        self._starting[key] = token

        # Replace any stale instance for the same channel. _teardown (not
        # stop_bot) so our own fresh reservation survives it.
        await self._teardown(key)
        if self._starting.get(key) is not token:
            print(
                f"visio-bot-service: bot {key} was stopped while its predecessor "
                "was being replaced; not starting",
                flush=True,
            )
            return

        bot = None
        try:
            # Resolve the capability descriptor generically: the generic map
            # meta.native[<botType>] wins, with meta.linto_native as the one-release
            # back-compat alias for "visio-native". A malformed/missing descriptor
            # trips the KeyError/TypeError below -> bot-error (invalid payload).
            meta = session["meta"]
            desc = (meta.get("native") or {}).get(data.get("botType")) or meta.get(
                "linto_native"
            )
            join_token = desc.get("token") if desc else None
            # Fail closed in payload-token mode: never env-mint a devkey against a
            # real LiveKit. No token -> bot-error (the Scheduler re-routes to web).
            if self.token_from_payload and not join_token:
                raise RuntimeError(
                    "LIVEKIT_TOKEN_FROM_PAYLOAD set but startbot payload carries no "
                    "join token — failing closed (no env-mint)"
                )
            # SSRF: livekitUrl comes straight out of client-writable session meta,
            # and the bot dials it from inside the cluster. Validate before it ever
            # reaches the SDK (fail closed) — the sibling web-bot path does the same
            # for the meeting URL it hands to Playwright.
            livekit_url = desc["livekitUrl"]
            url_error = validate_livekit_url(
                livekit_url,
                allowed_hosts=self.livekit_allowed_hosts,
                allow_private=self.livekit_allow_private,
            )
            if url_error:
                raise RuntimeError(f"{url_error} ({livekit_url!r})")
            bot = LiveKitBot(
                livekit_url=livekit_url,
                room_name=desc["room"],
                websocket_url=data["websocketUrl"],
                bot_id=bot_id,
                join_token=join_token,
            )
            # Per-bot opt-out for in-room caption injection: Studio sends
            # enableDisplaySub and the Scheduler forwards it, so an explicit `false`
            # must win over the replica-wide VISIOBOT_PUBLISH_NATIVE_SUBS default
            # (which stays the kill-switch: an absent key keeps it, and it is never
            # overridden UP by a payload, since it also gates a token grant).
            if data.get("enableDisplaySub") is False:
                bot.publish_captions = False
            # #C1: the transcriber WS closes on routine Transcriber events. The
            # stream reconnects on its own with bounded backoff; when its retries
            # are exhausted this brings the bot down and tells the Scheduler why,
            # so it can re-route instead of leaving a bot streaming into the void.
            stream = getattr(bot, "transcriber", None)
            if stream is not None:
                # `token` is handed over so the hook can tell "this bot is not
                # registered YET" (the startup window below) from "this bot was
                # replaced/stopped": the ladder can exhaust while start() is still
                # joining the room.
                stream.on_failure = (
                    lambda reason, b=bot, t=token: self._on_transcriber_failure(
                        b, key, session_id, channel_id, bot_id, reason, t
                    )
                )
            # Auto-leave, wired exactly like the web BotService's 'meeting-empty'
            # / 'join-timeout' events: the bot only decides WHEN to leave, the
            # owner tells the Scheduler and tears the bot down.
            bot.on_meeting_empty = (
                lambda b=bot: self._on_meeting_empty(b, key, session_id, channel_id, bot_id)
            )
            bot.on_join_timeout = (
                lambda b=bot: self._on_join_timeout(b, key, session_id, channel_id, bot_id)
            )
            ok = await bot.start()
            if not ok:
                raise RuntimeError("LiveKit/transcriber connect failed")
            # K5: a stopbot (or a newer startbot) that landed during start() took
            # the key from us — this bot is an orphan. stop_bot would no-op on the
            # missing key and leak a live room/WS, so dispose it directly.
            if self._starting.get(key) is not token:
                print(
                    f"visio-bot-service: bot {key} was stopped during start, "
                    "disposing orphan",
                    flush=True,
                )
                await bot.dispose()
                return
            self._starting.pop(key, None)
            self.bots[key] = bot
            # Follow this channel's live captions so the bot can republish them
            # into the room (transcriber/out/<sid>/<cid>/{partial,final}[/translations]).
            if bot.publish_captions:
                topic = self._caption_topic(session_id, channel_id)
                self._caption_subs[key] = topic
                if self.client is not None:
                    self.client.subscribe(topic, qos=0)
            self._publish_status(True)
            print(f"visio-bot-service: started bot {key} (botId {bot_id})", flush=True)
        except Exception as e:  # noqa: BLE001
            print(f"visio-bot-service: startBot {key} failed: {e}", flush=True)
            # Release the reservation only if it is still ours (a stopbot/newer
            # startbot that took it owns the key now).
            if self._starting.get(key) is token:
                self._starting.pop(key, None)
            # A transcriber failure raised DURING start() already published its own
            # bot-error (and disposed the bot); do not report the same dead bot twice.
            if not getattr(bot, "_failure_reported", False):
                self._publish_bot_error(bot_id, "join-failed")
            if bot is not None:
                try:
                    await bot.dispose()
                except Exception:  # noqa: BLE001
                    pass

    async def _on_transcriber_failure(
        self, bot, key, session_id, channel_id, bot_id, reason, token=None
    ) -> None:
        """The bot's Transcriber link is gone for good (reconnects exhausted).

        Publish the structured bot-error the Scheduler subscribes to, then tear the
        bot down — a bot with no transcriber produces nothing but still holds a
        LiveKit room and is counted in activeBots.

        Three ownership cases, which a plain `self.bots.get(key) is not bot` guard
        conflated into one silent return:
          - a DIFFERENT bot owns the key: it replaced us, nothing to report here;
          - nobody owns it and our K5 reservation is gone: a stopbot (or a newer
            startbot) already won and the start path disposes this bot — an
            intentional stop must not produce a bot-error;
          - nobody owns it and the reservation is STILL ours: the STARTUP WINDOW.
            on_failure is armed before `bot.start()` and the reconnect ladder can
            exhaust (~7 s by default) while start() is still joining the LiveKit
            room. This used to swallow the failure entirely: no bot-error, no
            dispose, and start() then registered a bot with a permanently dead
            transcriber — a room held, activeBots inflated, nothing produced.
        """
        owner = self.bots.get(key)
        if owner is not None and owner is not bot:
            return  # already replaced; nothing to report for this instance
        if owner is None:
            if token is None or self._starting.get(key) is not token:
                return  # already stopped, or superseded: the start path owns it
            # Revoke our OWN reservation so start_bot cannot register a bot whose
            # transcriber is dead for good (it sees the missing token and disposes
            # the orphan), and mark the failure reported so its error path does not
            # publish a second bot-error on top of this one.
            self._starting.pop(key, None)
            try:
                bot._failure_reported = True
            except Exception:  # noqa: BLE001 — a stand-in that refuses attributes
                pass
            print(
                f"visio-bot-service: bot {key} (botId {bot_id}) transcriber failure "
                f"during start: {reason}",
                flush=True,
            )
            self._publish_bot_error(bot_id, reason)
            # stop_bot would no-op on a key `bots` does not hold yet, so dispose
            # this instance directly — it may already hold a LiveKit room.
            try:
                await bot.dispose()
            except Exception as e:  # noqa: BLE001
                print(f"visio-bot-service: dispose {key} on start failure: {e}", flush=True)
            return
        print(
            f"visio-bot-service: bot {key} (botId {bot_id}) transcriber failure: "
            f"{reason}",
            flush=True,
        )
        self._publish_bot_error(bot_id, reason)
        await self.stop_bot(session_id, channel_id)

    @staticmethod
    def _caption_topic(session_id, channel_id) -> str:
        return f"transcriber/out/{session_id}/{channel_id}/#"

    # ---- autonomous leaves (parity with the web BotService) ---------------
    def _request_scheduler_cleanup(self, bot_id, end_session: bool = False) -> None:
        """Ask the Scheduler to delete the Bot row and mark the channel inactive —
        the same path Session-API uses for DELETE /bots. With `end_session` (the
        meeting emptied out: everyone left a real meeting) it also ENDS the
        session so Studio finalizes it exactly like a manual stop (terminated +
        sessions/ended). Mirrors BotService `_requestSchedulerCleanup`."""
        if not isinstance(bot_id, int) or bot_id <= 0:
            print(
                f"visio-bot-service: scheduler cleanup (endSession={end_session}) "
                f"dropped — missing/invalid botId {bot_id!r}",
                flush=True,
            )
            return
        if self.client is None:
            return
        self.client.publish(
            "scheduler/in/schedule/stopbot",
            json.dumps({"botId": bot_id, "endSession": end_session}),
            qos=1,
            retain=False,
        )

    async def _on_meeting_empty(self, bot, key, session_id, channel_id, bot_id) -> None:
        if self.bots.get(key) is not bot:
            return  # replaced or already stopped: not ours to end
        print(
            f"visio-bot-service: bot {key} (botId {bot_id}) meeting empty, leaving "
            "and ending the session",
            flush=True,
        )
        self._request_scheduler_cleanup(bot_id, end_session=True)
        await self.stop_bot(session_id, channel_id)

    async def _on_join_timeout(self, bot, key, session_id, channel_id, bot_id) -> None:
        if self.bots.get(key) is not bot:
            return
        # A never-populated room is a FAILURE, not a clean end of meeting: record
        # it as a distinct bot-error so the Scheduler does not count it a success,
        # and ask for the row/channel cleanup WITHOUT ending the session.
        print(
            f"visio-bot-service: bot {key} (botId {bot_id}) never saw a participant "
            "(join timeout), leaving",
            flush=True,
        )
        self._publish_bot_error(bot_id, "join-timeout")
        self._request_scheduler_cleanup(bot_id)
        await self.stop_bot(session_id, channel_id)

    async def stop_bot(self, session_id, channel_id) -> None:
        key = f"{session_id}_{channel_id}"
        # K5: revoke any in-flight start for this key FIRST, before any await. A
        # start that completes after this point sees a foreign/absent reservation
        # and disposes itself, so a stop that arrives mid-start deterministically
        # wins instead of leaving an untracked bot in the room.
        self._starting.pop(key, None)
        await self._teardown(key)

    async def _teardown(self, key: str) -> None:
        """Dispose the bot registered under `key`, if any. Touches NO reservation:
        start_bot calls this to replace a predecessor while holding its own."""
        bot = self.bots.pop(key, None)
        if bot is None:
            return
        print(f"visio-bot-service: stopping bot {key}", flush=True)
        topic = self._caption_subs.pop(key, None)
        if topic is not None and self.client is not None:
            try:
                self.client.unsubscribe(topic)
            except Exception:  # noqa: BLE001
                pass
        try:
            await bot.dispose()
        except Exception as e:  # noqa: BLE001
            print(f"visio-bot-service: dispose {key}: {e}", flush=True)
        self._publish_status(True)
