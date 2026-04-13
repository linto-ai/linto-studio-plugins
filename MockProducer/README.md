# MockProducer

Standalone tool that simulates the Transcriber and TranslatorPython services by publishing MQTT messages in a loop. Useful for testing the frontend, Scheduler, or any MQTT consumer without a real audio stream or ASR provider.

## Prerequisites

- Python 3.12+
- [uv](https://docs.astral.sh/uv/)
- An accessible MQTT broker (e.g. Mosquitto via `docker compose up broker`)
- The Session-API running with at least one session created

## Installation

```bash
cd MockProducer
uv sync
```

## Usage

```bash
uv run python -m mock_producer --session-id <uuid>
```

The mock will:

1. Fetch the session from the Session-API
2. Start one async worker per channel
3. Publish partial → final sequences + translation messages in a loop
4. Shut down gracefully on Ctrl+C

### Options

| Option | Default | Description |
|---|---|---|
| `--session-id` | (required) | Session UUID |
| `--session-api-url` | `http://localhost:8000` | Session-API base URL (or `$SESSION_API_HOST`) |
| `--partial-interval` | `0.3` | Seconds between partial messages |
| `--final-delay` | `0.5` | Seconds before final after last partial |
| `--inter-segment` | `1.5` | Pause between segments |
| `--translation-delay` | `0.2` | Delay before publishing translations |
| `--corpus-file` | built-in | Text file with one sentence per line |
| `--no-loop` | off | Stop after one pass through the corpus |
| `--quiet` | off | Reduced logging (startup + errors only) |

### Broker configuration

Uses the same environment variables as the rest of the project:

```bash
BROKER_HOST=localhost    # default
BROKER_PORT=1883         # default
BROKER_USERNAME=         # optional
BROKER_PASSWORD=         # optional
```

### Examples

```bash
# Basic
uv run python -m mock_producer --session-id 550e8400-e29b-41d4-a716-446655440000

# Remote broker, custom API port
BROKER_HOST=192.168.1.10 uv run python -m mock_producer \
  --session-id 550e8400-e29b-41d4-a716-446655440000 \
  --session-api-url http://localhost:8005

# Slow pace, single pass
uv run python -m mock_producer \
  --session-id 550e8400-e29b-41d4-a716-446655440000 \
  --partial-interval 0.5 --inter-segment 3 --no-loop

# Custom corpus
uv run python -m mock_producer \
  --session-id 550e8400-e29b-41d4-a716-446655440000 \
  --corpus-file ./corpus/fr.txt
```

## Published MQTT topics

For each channel in the session:

| Topic | Content |
|---|---|
| `transcriber/out/{sessionId}/{channelId}/partial` | Partial transcription (text builds up word by word) |
| `transcriber/out/{sessionId}/{channelId}/final` | Final transcription (complete sentence) |
| `transcriber/out/{sessionId}/{channelId}/partial/translations` | Translations for partials |
| `transcriber/out/{sessionId}/{channelId}/final/translations` | Translations for finals |

Payloads match the exact format used by the real services (see `ASREvents.js` and `pipeline.py`).

## Verification

```bash
# Terminal 1: listen to all messages
mosquitto_sub -t "transcriber/out/#" -v

# Terminal 2: run the mock
cd MockProducer && uv run python -m mock_producer --session-id <uuid>
```
