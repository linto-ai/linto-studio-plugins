import asyncio
import logging
import signal
import sys

import aiomqtt

from mock_producer.cli import parse_args
from mock_producer.corpus import load_corpus
from mock_producer.publisher import channel_worker
from mock_producer.session import fetch_session


async def main() -> None:
    config = parse_args()

    logging.basicConfig(
        level=logging.WARNING if config.quiet else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )
    logger = logging.getLogger(__name__)

    # Fetch session
    logger.info("Fetching session %s from %s", config.session_id, config.session_api_url)
    try:
        session = await fetch_session(config)
    except Exception as e:
        logger.error("Failed to fetch session: %s", e)
        sys.exit(1)

    channels = session.get("channels", [])
    if not channels:
        logger.error("Session has no channels")
        sys.exit(1)

    logger.info(
        "Session '%s' (%s): %d channel(s)",
        session.get("name", "?"), session.get("status", "?"), len(channels),
    )

    # Load corpus
    try:
        corpus = load_corpus(config.corpus_file)
    except Exception as e:
        logger.error("Failed to load corpus: %s", e)
        sys.exit(1)

    logger.info("Corpus: %d sentences%s", len(corpus), " (looping)" if not config.no_loop else "")

    # Graceful shutdown
    stop_event = asyncio.Event()

    def on_signal() -> None:
        logger.info("Shutting down...")
        stop_event.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, on_signal)

    # Connect and run workers
    try:
        async with aiomqtt.Client(
            hostname=config.broker_host,
            port=config.broker_port,
            username=config.broker_username,
            password=config.broker_password,
        ) as client:
            logger.info("Connected to MQTT broker %s:%d", config.broker_host, config.broker_port)

            workers = [
                channel_worker(client, session["id"], ch, corpus, config, stop_event)
                for ch in channels
            ]
            await asyncio.gather(*workers)
    except aiomqtt.MqttError as e:
        logger.error("MQTT error: %s", e)
        sys.exit(1)

    logger.info("Done.")


if __name__ == "__main__":
    asyncio.run(main())
