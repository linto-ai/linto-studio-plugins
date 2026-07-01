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
import json
import os
import resource
import uuid

import paho.mqtt.client as mqtt

from bot.livekit_bot import LiveKitBot

HEARTBEAT_S = 15


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

        self.bots: dict[str, LiveKitBot] = {}  # `${sessionId}_${channelId}` -> LiveKitBot
        self.loop: asyncio.AbstractEventLoop | None = None
        self.client: mqtt.Client | None = None
        self._stopping: asyncio.Event | None = None

    # ---- status -----------------------------------------------------------
    def _rss_bytes(self) -> int:
        # ru_maxrss is kilobytes on Linux; report bytes to match the web
        # BotService's process.memoryUsage().rss so the Scheduler can compare.
        try:
            return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024
        except Exception:
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

        # Dispose bots first: leaves the LiveKit rooms and closes the transcriber
        # WebSockets cleanly before we go offline on the broker.
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
        self._publish_status(True)
        print(f"visio-bot-service: connected, subscribed to {self.sub}", flush=True)

    def _on_message(self, client, userdata, msg) -> None:
        # Runs on the paho network thread — never touch asyncio state directly,
        # dispatch every coroutine back onto self.loop.
        try:
            parts = msg.topic.split("/")
            action = parts[3] if len(parts) > 3 else None
            data = json.loads(msg.payload.decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            print(f"visio-bot-service: malformed MQTT message on {msg.topic}: {e}", flush=True)
            return

        if self.loop is None:
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

        # Replace any stale instance for the same channel.
        await self.stop_bot(session_id, channel_id)

        bot = None
        try:
            native = session["meta"]["linto_native"]
            bot = LiveKitBot(
                livekit_url=native["livekitUrl"],
                room_name=native["room"],
                websocket_url=data["websocketUrl"],
                bot_id=bot_id,
            )
            ok = await bot.start()
            if not ok:
                raise RuntimeError("LiveKit/transcriber connect failed")
            self.bots[key] = bot
            self._publish_status(True)
            print(f"visio-bot-service: started bot {key} (botId {bot_id})", flush=True)
        except Exception as e:  # noqa: BLE001
            print(f"visio-bot-service: startBot {key} failed: {e}", flush=True)
            self._publish_bot_error(bot_id, "join-failed")
            if bot is not None:
                try:
                    await bot.dispose()
                except Exception:  # noqa: BLE001
                    pass

    async def stop_bot(self, session_id, channel_id) -> None:
        key = f"{session_id}_{channel_id}"
        bot = self.bots.pop(key, None)
        if bot is None:
            return
        print(f"visio-bot-service: stopping bot {key}", flush=True)
        try:
            await bot.dispose()
        except Exception as e:  # noqa: BLE001
            print(f"visio-bot-service: dispose {key}: {e}", flush=True)
        self._publish_status(True)
