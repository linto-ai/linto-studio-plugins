"""visio-bot-service bootstrap (equiv. BotService/botservice.js).

A native LiveKit transcription bot service: it is piloted entirely over MQTT
(no Chromium, no livekit-agents worker). It joins a Visio/Meet room as a HIDDEN
participant, mixes every remote participant's audio into one 16 kHz mono PCM
stream and forwards it to a LinTO Transcriber over the existing WS ingest
protocol.

Components are selected via VISIOBOT_COMPONENTS (comma separated, default
"BrokerClient,Healthcheck"):
  - BrokerClient — the MQTT contract + bot lifecycle (the actual service).
  - Healthcheck  — a stdlib HTTP /healthcheck endpoint in a background thread.
"""
import asyncio
import os
import signal

from components.broker_client import BrokerClient
from components.healthcheck import Healthcheck


def _validate_env() -> None:
    """Fail fast on obviously-unusable LiveKit credentials outside dev mode.

    In DEVELOPMENT the devkey/secret pair is the intended local default. Anywhere
    else, leaving them (or blanking them) means the service would advertise itself
    online and only fail late — at startBot, with a `join-failed` — so refuse to
    start instead of silently accepting work it cannot do.
    """
    if os.environ.get("DEVELOPMENT", "").lower() in ("1", "true"):
        return
    key = os.environ.get("LIVEKIT_API_KEY", "devkey")
    secret = os.environ.get("LIVEKIT_API_SECRET", "secret")
    if not key or not secret or key == "devkey" or secret == "secret":
        raise SystemExit(
            "visio-bot-service: refusing to start — LIVEKIT_API_KEY/LIVEKIT_API_SECRET "
            "are unset or still the devkey/secret placeholders "
            "(set DEVELOPMENT=true for local runs)"
        )


async def main() -> None:
    _validate_env()

    selected = [
        c.strip()
        for c in os.environ.get("VISIOBOT_COMPONENTS", "BrokerClient,Healthcheck").split(",")
        if c.strip()
    ]

    broker = None
    tasks = []

    if "BrokerClient" in selected:
        broker = BrokerClient()
        tasks.append(asyncio.create_task(broker.run()))

    if "Healthcheck" in selected:
        # Runs its HTTP server in a daemon thread, so it is not part of the gather.
        Healthcheck(broker).start()

    # Graceful shutdown. asyncio.run only wires SIGINT, and as PID 1 the kernel
    # ignores SIGTERM's default disposition — so without an explicit handler
    # `docker stop`/k8s would hang until the SIGKILL grace timeout and never
    # dispose the bots. Both signals flip the same stop event.
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:  # pragma: no cover - non-Unix platforms
            pass

    if not tasks:
        # Nothing long-running besides the (threaded) healthcheck; idle until signalled.
        await stop.wait()
        return

    # Run until a signal arrives or a long-running task exits on its own.
    stop_task = asyncio.create_task(stop.wait())
    await asyncio.wait({*tasks, stop_task}, return_when=asyncio.FIRST_COMPLETED)

    try:
        if broker is not None:
            await broker.shutdown()
    finally:
        for t in (*tasks, stop_task):
            t.cancel()
        # return_exceptions so a task that already failed does not mask shutdown.
        await asyncio.gather(*tasks, stop_task, return_exceptions=True)


if __name__ == "__main__":
    asyncio.run(main())
