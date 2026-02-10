"""Entry point: async event loop, signal handlers."""

import asyncio
import logging
import signal
import sys


def main() -> None:
    """Main entry point for the translator service."""
    # Import config first to trigger TRANSLATOR_NAME validation
    from translator import config
    from translator.mqtt_handler import MqttHandler
    from translator.pipeline import Pipeline
    from translator.providers import load_provider

    # Configure logging
    logging.basicConfig(
        level=getattr(logging, config.LOG_LEVEL.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
    )
    logger = logging.getLogger(__name__)

    logger.info(
        "Translator starting: name=%s, provider=%s",
        config.TRANSLATOR_NAME,
        config.TRANSLATION_PROVIDER,
    )

    # Instantiate provider
    provider = load_provider(config.TRANSLATION_PROVIDER)

    # Create pipeline
    pipeline = Pipeline(
        provider=provider,
        publish_fn=None,  # Will be set after MqttHandler is created
        change_threshold=config.CHANGE_THRESHOLD,
        min_new_chars=config.MIN_NEW_CHARS,
        debounce_ms=config.PARTIAL_DEBOUNCE_MS,
        stability_threshold=config.STABILITY_THRESHOLD,
        max_hold_seconds=config.MAX_HOLD_SECONDS,
        max_consecutive_holds=config.MAX_CONSECUTIVE_HOLDS,
    )

    # Create MQTT handler
    handler = MqttHandler(
        broker_host=config.BROKER_HOST,
        broker_port=config.BROKER_PORT,
        translator_name=config.TRANSLATOR_NAME,
        languages=config.EU_LANGUAGES,
        pipeline=pipeline,
    )

    # Wire publish function
    pipeline.publish_fn = handler.publish_translation

    # Run with signal handling
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    async def run_with_shutdown() -> None:
        # Register signal handlers
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, lambda: asyncio.ensure_future(handler.shutdown()))

        await handler.run()

    try:
        loop.run_until_complete(run_with_shutdown())
    except KeyboardInterrupt:
        pass  # Signal handler already triggered shutdown
    finally:
        loop.close()
        logger.info("Translator stopped")


if __name__ == "__main__":
    main()
