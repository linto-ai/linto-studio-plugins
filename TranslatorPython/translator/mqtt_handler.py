"""MQTT client: subscriptions, LWT setup, message routing."""

import asyncio
import json
import logging
from typing import Any

import aiomqtt

from translator.pipeline import Pipeline

logger = logging.getLogger(__name__)


class MqttHandler:
    """Manages MQTT connection, subscriptions, and message routing.

    Args:
        broker_host: MQTT broker hostname.
        broker_port: MQTT broker port.
        translator_name: Unique translator identifier.
        languages: List of supported language codes.
        pipeline: Anti-flicker pipeline instance.
    """

    def __init__(
        self,
        broker_host: str,
        broker_port: int,
        translator_name: str,
        languages: list[str],
        pipeline: Pipeline,
    ) -> None:
        self.broker_host = broker_host
        self.broker_port = broker_port
        self.translator_name = translator_name
        self.languages = languages
        self.pipeline = pipeline

        self.status_topic = f"translator/out/{translator_name}/status"
        self.online_payload = json.dumps(
            {"name": translator_name, "languages": languages, "online": True}
        )
        self.offline_payload = json.dumps(
            {"name": translator_name, "languages": [], "online": False}
        )

        self._client: aiomqtt.Client | None = None
        self._shutdown_event = asyncio.Event()

    async def publish_translation(
        self,
        session_id: str,
        channel_id: str,
        action: str,
        payload: dict[str, Any],
        key: str,
    ) -> None:
        """Publish a translation result to MQTT.

        Args:
            session_id: Session identifier from the topic.
            channel_id: Channel identifier from the topic.
            action: "partial" or "final".
            payload: Translation payload dict.
            key: Pipeline state key (for logging).
        """
        if self._client is None:
            logger.warning("Cannot publish: MQTT client not connected")
            return

        topic = f"transcriber/out/{session_id}/{channel_id}/{action}/translations"
        try:
            await self._client.publish(
                topic, json.dumps(payload), qos=1
            )
            logger.debug("Published to %s: segmentId=%s", topic, payload.get("segmentId"))
        except Exception:
            logger.exception("Failed to publish to %s", topic)

    async def run(self) -> None:
        """Run the MQTT client with reconnection loop."""
        while not self._shutdown_event.is_set():
            try:
                await self._connect_and_listen()
            except aiomqtt.MqttError as exc:
                if self._shutdown_event.is_set():
                    break
                logger.warning("MQTT connection lost (%s), reconnecting in 3s...", exc)
                try:
                    await asyncio.wait_for(
                        self._shutdown_event.wait(), timeout=3.0
                    )
                    break  # Shutdown requested during reconnect wait
                except asyncio.TimeoutError:
                    continue  # Retry connection
            except asyncio.CancelledError:
                break

    async def _connect_and_listen(self) -> None:
        """Connect to broker, subscribe, and process messages."""
        will = aiomqtt.Will(
            topic=self.status_topic,
            payload=self.offline_payload,
            qos=1,
            retain=True,
        )

        async with aiomqtt.Client(
            hostname=self.broker_host,
            port=self.broker_port,
            clean_session=True,
            will=will,
        ) as client:
            self._client = client
            logger.info("Connected to MQTT broker at %s:%d", self.broker_host, self.broker_port)

            # Publish online status
            await client.publish(
                self.status_topic, self.online_payload, qos=1, retain=True
            )
            logger.info("Published online status to %s", self.status_topic)

            # Subscribe to transcription topics
            await client.subscribe("transcriber/out/+/+/final", qos=1)
            await client.subscribe("transcriber/out/+/+/partial", qos=1)
            logger.info("Subscribed to transcriber/out/+/+/final and partial")

            # Start stats logger
            await self.pipeline.start_stats_logger()

            # Process messages
            async for message in client.messages:
                if self._shutdown_event.is_set():
                    break
                try:
                    await self._handle_message(message)
                except Exception:
                    logger.exception("Error processing message on topic %s", message.topic)

    async def _handle_message(self, message: aiomqtt.Message) -> None:
        """Route an incoming MQTT message through the pipeline."""
        topic_str = str(message.topic)
        parts = topic_str.split("/")
        if len(parts) != 5:
            return

        # transcriber/out/{sessionId}/{channelId}/{action}
        session_id = parts[2]
        channel_id = parts[3]
        action = parts[4]

        if action not in ("final", "partial"):
            return

        try:
            payload = message.payload
            if isinstance(payload, (bytes, bytearray)):
                payload = payload.decode("utf-8")
            transcription = json.loads(payload)
        except (json.JSONDecodeError, UnicodeDecodeError):
            logger.warning("Invalid JSON on topic %s", topic_str)
            return

        # Filter: check externalTranslations for our translator
        external = transcription.get("externalTranslations")
        if not external or not isinstance(external, list):
            return

        matching_targets = [
            entry for entry in external
            if entry.get("translator") == self.translator_name
        ]
        if not matching_targets:
            return

        # Skip empty text
        text = transcription.get("text", "")
        if not text or not text.strip():
            return

        # Skip packets with no source language — can't translate without it
        if not transcription.get("lang"):
            logger.debug("Skipping packet with no source lang on %s", topic_str)
            return

        if action == "final":
            await self.pipeline.handle_final(
                session_id, channel_id, transcription, matching_targets
            )
        else:
            await self.pipeline.handle_partial(
                session_id, channel_id, transcription, matching_targets
            )

    async def shutdown(self) -> None:
        """Gracefully shut down the MQTT handler."""
        if self._shutdown_event.is_set():
            return  # Already shutting down
        logger.info("Shutting down MQTT handler...")
        self._shutdown_event.set()

        # Stop pipeline (cancel all pending tasks)
        await self.pipeline.stop()

        # Publish offline status then disconnect
        if self._client is not None:
            try:
                await self._client.publish(
                    self.status_topic, self.offline_payload, qos=1, retain=True
                )
                logger.info("Published offline status")
            except Exception:
                logger.warning("Failed to publish offline status during shutdown")
            # Force-disconnect to break out of async for client.messages
            try:
                self._client._client.disconnect()
            except Exception:
                pass
