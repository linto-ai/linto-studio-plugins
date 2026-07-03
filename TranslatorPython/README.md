# Translator

External translation microservice. Subscribes to transcription partials and finals via MQTT,
translates text using pluggable providers (echo, TranslateGemma), and publishes results back to
the broker on `transcriber/out/{sessionId}/{channelId}/{partial|final}/translations`.

## How it works: prefix freezing

The ASR emits *cumulative* partials (the segment text grows word by word), then a *final* that
closes the segment. Retranslating the whole cumulative text on every partial has quadratic cost
and melts the translation backend from a handful of concurrent channels. Instead, the unit of
translation is the **sentence**:

- A sentence closed by strong punctuation is **frozen**: translated exactly once, never
  re-segmented, never re-translated. This happens immediately when the punctuation appears in a
  partial, without waiting for the final.
- The **tail** (the sentence currently being spoken, between the last punctuation and the end of
  the text) is NOT translated by default. It can be translated "live" as an option, through a
  rate-limited latest-wins slot (`TAIL_LIVE_MS`).
- When the speaker doesn't punctuate (continuous speech), the tail is force-frozen every
  `SOFT_CHUNK_CHARS` characters, cut at the last comma or space.
- The published text is always `frozen translations + tail translation`: the displayed prefix
  never flickers, by construction.
- **Finals always win.** They are handled immediately (never queued behind partial work, never
  blocking the MQTT loop), and reuse the frozen translations: when the final text matches what
  was already translated, the final costs **zero** requests. If the final rewrote the past
  (e.g. punctuation added everywhere), it is fully retranslated once.

All provider requests go through a scheduler with a global concurrency cap
(`MAX_CONCURRENT_TRANSLATIONS`): total demand is bounded by construction and cannot spiral when
the backend slows down.

## Operating modes

Two knobs select the mode; everything else is fine-tuning.

| Mode | Setting | What the viewer sees | Measured cost* |
|---|---|---|---|
| **Default** | `TAIL_LIVE_MS=0` | Translated captions advance sentence by sentence, as punctuation appears; the in-progress sentence stays still | 1.07× useful tokens, 29 tok/s @ 10 channels |
| **Live tail** | `TAIL_LIVE_MS=2000-3000` | Same, plus the in-progress sentence refreshes every N seconds | 3.0× @ 3000 ms, 91 tok/s @ 10 channels |
| **Eco** | `TRANSLATE_PARTIALS=false` | Captions only appear at finals (VAD pauses / end of turn) | 1.05× (the floor), 31 tok/s @ 10 channels |

\* Replayed from a real 61-minute 10-channel capture, 1 target language, against a simulated
healthy backend (see the load bench below). Baseline before the redesign was **17.2×** and
535 tok/s @ 10 channels, above the ~500 tok/s ceiling of a typical translation backend.

## Configuration reference

Copy `.envdefault` to `.env` and override as needed. By cost impact:

| ENV | Default | Role |
|---|---|---|
| `TRANSLATE_PARTIALS` | `true` | `false` = eco mode: nothing is translated during partials, only finals. |
| `TAIL_LIVE_MS` | `0` | Refresh cadence of the in-progress sentence. `0` = never (punctuation-driven only). `N>0` = live tail updates: at most ONE in flight per channel/language, at most one fired every N ms, latest text wins (intermediate versions are discarded without ever reaching the model). Cost scales roughly with 1/N. Punctuation freezes and finals are NOT subject to this cadence. |
| `SOFT_CHUNK_CHARS` | `220` | Freeze budget for unpunctuated speech: beyond this, the tail is cut at the last comma/space and frozen. Bounds both the max request size and the max display latency when the speaker never punctuates. Smaller = more reactive but more arbitrary cuts (translation quality); larger = better sentences but bigger requests. |
| `MAX_CONCURRENT_TRANSLATIONS` | `8` | Global semaphore of the process. The translator is a singleton, so this is the admission control of the WHOLE platform towards the translation backend. Size it against the backend's real capacity (vLLM `max-num-seqs`). |
| `MIN_NEW_CHARS` | `10` | Tail gate (only if `TAIL_LIVE_MS>0`): min new chars before submitting a tail update. Raise to 30-40 to save more. |
| `CHANGE_THRESHOLD` | `85` | Tail gate (only if `TAIL_LIVE_MS>0`): RapidFuzz similarity above which the update is skipped (combined with `MIN_NEW_CHARS`). |
| `STABILITY_THRESHOLD` | `0.6` | Display-only anti-flicker on the tail: hold a tail translation whose beginning diverges too much from what is displayed. No model cost (the request is already paid). |
| `MAX_CONSECUTIVE_HOLDS` | `2` | Force-publish after N consecutive holds. |
| `STATE_TTL_SECONDS` | `600` | Purge state of keys inactive longer than this (segments whose final never arrived). |

Provider (TranslateGemma):

| ENV | Default | Role |
|---|---|---|
| `TRANSLATION_PROVIDER` | `echo` | `echo` or `translategemma`. |
| `TRANSLATEGEMMA_ENDPOINT` | — | vLLM endpoint (required for translategemma). |
| `TRANSLATEGEMMA_MODEL` | `Infomaniak-AI/vllm-translategemma-4b-it` | Model name. |
| `TRANSLATEGEMMA_MAX_TOKENS` | `160` | Generation cap per request. Consistent with `SOFT_CHUNK_CHARS=220`; if you raise one, raise the other proportionally. A `finish_reason=length` warning is logged when a translation gets truncated. |
| `TRANSLATEGEMMA_TEMPERATURE` | `0.0` | Deterministic translations (less flicker between retranslations). Leave at 0. |

Service identity and broker: `TRANSLATOR_NAME` (required), `BROKER_HOST`, `BROKER_PORT`.

Deprecated and ignored (a warning is logged at startup if still set): `PARTIAL_DEBOUNCE_MS`,
`MAX_HOLD_SECONDS`.

## Telemetry

The service logs a `[stats]` line every 60 s (received/translated/published counters, freezes vs
tail updates, finals reused at zero cost, in-flight, superseded tails) plus, with the
translategemma provider, cumulative `prompt_tokens` / `completion_tokens` / truncations as
reported by vLLM. That line is the component's only telemetry: watch `completion_tokens` per
minute against the backend capacity.

## Development

```bash
uv sync --extra dev
.venv/bin/python -m pytest            # unit tests
```

### Load bench (replay of a real capture)

`benchmark/replay_capture.py` replays a recorded MQTT capture (mosquitto_sub format
`<unix_ts> | <topic> | <json>`) through the real pipeline with an instrumented stub provider and
a virtual-time event loop (an hour of capture replays in ~30 s, deterministic). No network, no
model: it measures what WOULD be sent (calls, tokens, concurrency, per-segment accounting).

```bash
.venv/bin/python benchmark/replay_capture.py capture.log --latency-ms 150 --decode-tps 100
.venv/bin/python benchmark/replay_capture.py capture.log --tail-live-ms 3000 ...
.venv/bin/python benchmark/replay_capture.py capture.log --no-translate-partials ...
```

Use it as a non-regression bench for any pipeline change: run before/after on the same capture
and compare `total_out_tokens_est`, `overhead_ratio` and the demand timeline.
