# E-Meeting integration test harness

Containerized end-to-end integration test infrastructure for the E-Meeting
platform. The stack is fully isolated from the dev compose (different
container names, network and host ports) so it can run side by side with a
running dev environment.

## Layout

```
tests/integration/
  docker-compose.test.yml        # Dedicated stack (broker, db, migration, sessionapi, scheduler, transcriber)
  run.sh                         # Orchestrator: up -> run scenarios -> down
  harness/
    lib.sh                       # Reusable bash helpers (harness::* functions)
    ws-stream.js                 # Node helper used by harness::stream_ws
  scenarios/
    00-smoke.sh                  # Minimal smoke test (profile + session lifecycle)
    ...
    16-transcriber-failover.sh   # LB-reroutes-reconnect-to-different-instance path
  fixtures/
    audio.wav                    # 5s mono 16kHz sine wave (generated with ffmpeg)
  docker-compose.failover.yml    # Overlay used by scenario 16 (adds transcriber2)
```

### Multi-instance scenarios

Scenario `16-transcriber-failover.sh` brings up a second Transcriber container
(`transcriber2`) on host ports 28889/udp, 21935/tcp, 28890/tcp via
`docker-compose.failover.yml`. It then streams to the primary instance, kills
the stream, waits for SRT inactivity tear-down, and streams to the second
instance — exercising the load-balancer-reroute-on-reconnect path described
in [`doc/production-topology.md`](../../doc/production-topology.md). The
scenario removes its extra container on exit; if it dies uncleanly, run:

```bash
docker compose -p emeeting-integration-test \
    -f tests/integration/docker-compose.test.yml \
    -f tests/integration/docker-compose.failover.yml \
    rm -fsv transcriber2
```

## Stack

| Service     | Image / build                | Host port           |
|-------------|------------------------------|---------------------|
| broker      | eclipse-mosquitto:2          | 1884 (mqtt)         |
| database    | postgres:16-alpine (tmpfs)   | 54320               |
| migration   | migration/Dockerfile         | -                   |
| sessionapi  | Session-API/Dockerfile       | 8001 -> 8000        |
| scheduler   | Scheduler/Dockerfile         | -                   |
| transcriber | Transcriber/Dockerfile       | 18889/udp, 11935, 18890 |

The default ASR provider is `fake`, so no Azure/AWS keys are required.

## Quick start

```bash
# build + start stack
make test-integration-up

# run all scenarios (brings stack up and tears it down at the end)
make test-integration

# tear the stack down
make test-integration-down
```

You can also call the orchestrator directly:

```bash
bash tests/integration/run.sh
ONLY='00-*.sh' bash tests/integration/run.sh    # Only run scenarios matching glob
KEEP_STACK=1 bash tests/integration/run.sh      # Leave stack running after the run
```

## Adding a new scenario

1. Create a new file under `tests/integration/scenarios/`, prefixed with a
   2-digit order number, e.g. `10-pause-resume.sh`.
2. Make it `chmod +x`.
3. Source the helper library and install the cleanup trap:

   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
   source "${SCRIPT_DIR}/../harness/lib.sh"
   harness::install_cleanup_trap
   ```

4. Use the `harness::*` helpers documented below.

## Helper reference (`harness/lib.sh`)

Lifecycle:
- `harness::up` - build images, start the stack, wait for `healthy`.
- `harness::down` - stop and remove containers, volumes and networks.
- `harness::logs SERVICE [N]` - tail N log lines of SERVICE.

HTTP:
- `harness::http METHOD URL [BODY]` - curl wrapper, asserts 2xx, prints body.
- `harness::get URL`, `harness::post URL BODY`, `harness::put URL [BODY]`.
- URLs starting with `/` are prefixed with `${HARNESS_API_BASE}${HARNESS_API_PREFIX}`
  (defaults to `http://localhost:8001/v1`).

Domain:
- `harness::create_transcriber_profile [NAME]` - prints created profile id.
- `harness::create_session PROFILE_ID [NAME]` - prints created session id.
- `harness::get_session ID` - prints JSON.
- `harness::assert_status SESSION_ID EXPECTED [TIMEOUT]` - polls until match.
- `harness::stop_session SESSION_ID`.

Streaming (each prints the streamer PID, also tracked for cleanup):
- `harness::stream_srt SESSION_ID CHANNEL_INDEX AUDIO_FILE [DURATION]`
- `harness::stream_rtmp SESSION_ID CHANNEL_INDEX AUDIO_FILE [DURATION]`
- `harness::stream_ws SESSION_ID CHANNEL_INDEX AUDIO_FILE [DURATION]`

MQTT:
- `harness::mqtt_subscribe TOPIC OUTPUT_FILE` - background `mosquitto_sub`,
  appends `topic message` lines to OUTPUT_FILE.
- `harness::mqtt_assert_silent TOPIC SECONDS` - succeeds iff no message
  arrives during the window.
- `harness::mqtt_assert_received TOPIC PATTERN [TIMEOUT]` - waits for a
  message matching PATTERN.

## Configuration knobs

All settings have safe defaults but can be overridden via env vars:

| Variable                       | Default                         |
|--------------------------------|---------------------------------|
| `HARNESS_COMPOSE_FILE`         | tests/integration/docker-compose.test.yml |
| `HARNESS_PROJECT_NAME`         | emeeting-integration-test       |
| `HARNESS_API_BASE`             | http://localhost:8001           |
| `HARNESS_API_PREFIX`           | /v1                             |
| `HARNESS_MQTT_HOST` / `_PORT`  | 127.0.0.1 / 1884                |
| `HARNESS_SRT_HOST` / `_PORT`   | 127.0.0.1 / 18889               |
| `HARNESS_RTMP_HOST` / `_PORT`  | 127.0.0.1 / 11935               |
| `HARNESS_WS_HOST` / `_PORT`    | 127.0.0.1 / 18890               |
| `HARNESS_STREAMING_PASSPHRASE` | testpassphrase                  |
| `HARNESS_HEALTHY_TIMEOUT`      | 180 seconds                     |

## Debugging tips

- Run a single scenario in isolation:
  ```bash
  ONLY='00-*' KEEP_STACK=1 bash tests/integration/run.sh
  ```
  then inspect with `docker compose -p emeeting-integration-test \
      -f tests/integration/docker-compose.test.yml logs -f sessionapi`.

- Hit Session-API directly: `curl http://localhost:8001/v1/sessions | jq`.

- Tail MQTT traffic:
  ```bash
  mosquitto_sub -h 127.0.0.1 -p 1884 -v -t '#'
  ```

- Connect to the test database:
  ```bash
  PGPASSWORD=emeeting psql -h 127.0.0.1 -p 54320 -U emeeting emeeting_test
  ```

## Requirements on the host

- Docker + `docker compose` v2.
- `curl`, `jq`, `mosquitto_sub`, `mosquitto_pub`, `nc` (netcat).
- `gst-launch-1.0` (for `harness::stream_srt`).
- `ffmpeg` (for `harness::stream_rtmp`, `harness::stream_ws` and the audio
  fixture regeneration).
- `node` with the `ws` module installed in `Transcriber/node_modules`
  (already a transitive dep, so `npm ci` in `Transcriber/` is sufficient).
