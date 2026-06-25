# 1.5.0

_2026_06_25_

- BotService (new dedicated meeting-bot microservice)
  - The meeting bot, previously embedded in the Transcriber, now runs as its own horizontally-scalable service; bots arrive as a normal WS audio stream (the embedded puppeteer-stream bot and the bundled chromium download were removed from the Transcriber image)
  - New `visio` (LinTO Meet / LiveKit SFU, joins as guest) and `teams` (Microsoft Teams web client) bot providers — `bots.provider` enum extended + migration; the stale `youtube` value was dropped
  - One shared headless Chromium per replica, one isolated browser context per bot (`BrowserPool`: hard concurrency cap, lazy launch, crash auto-restart)
  - Per-platform manifests validated against an allowlist; declarative Playwright login rules; `{{botName}}` templating; participant join/leave tracking with an empty-meeting auto-leave timer
  - In-page WebRTC interception (RTCPeerConnection patch + AudioWorklet capture, resampled to 16 kHz): SFU per-participant tracks feed native diarization; Teams uses the single server-mixed track with page-polled speaker changes
  - `AudioMixer`: per-participant S16LE 16 kHz mixing in 20 ms frames with energy-VAD dominant-speaker detection
  - Broker contract: advertises capabilities + active-bot load to the Scheduler (`status` + 15 s heartbeat); handles targeted `startbot`/`stopbot`
  - `TranscriberStream` bridge over the existing WS ingest protocol (init/ack handshake, ACK-gated buffering, speaker forwarding); survives a transient Transcriber reconnect (bounded backoff + ordered buffer replay) without losing audio
  - Healthcheck component + Docker `HEALTHCHECK` reporting `{status, activeBots, browserConnected, audioServerListening}`
  - Resilience: init-ack watchdog + early-audio reaper, `BrowserPool.destroy()` cancels in-flight launches, concurrency-safe context creation, loopback-WS resync replays the participant mapping after a Node audio-server restart (fixes silent first words)
  - Capacity & observability: heartbeat carries process RSS/heapUsed + lifecycle metrics; a memory ceiling (`BOTSERVICE_MAX_RSS_MB`) sheds load under pressure; fatal bot failures publish `botservice/out/<id>/bot-error`
  - Wired into the dev compose and the CI image build (+ staging deploy stage); 7 code-only tunables documented in `.envdefault(.docker)`
- Native diarization (meeting-provided speakers)
  - Transcriber WS ingest accepts native-diarization control messages (`speakerChanged`/`participant`) interleaved with PCM; a new `SpeakerTracker` stamps each ASR segment with the meeting-provided speaker, with a short grace window to absorb the ASR-partial-vs-bot-event race
  - Robust inline-JSON-vs-audio splitting: a PCM frame that coincidentally looks like JSON falls through to audio, so no frame is dropped
  - Teams diarization fallback: on repeated control-poll misses the bot emits `diarizationDegraded` and falls back to ASR diarization instead of silently producing no speaker
- Session pause / resume
  - Add `PUT /v1/sessions/:id/pause` and `PUT /v1/sessions/:id/resume` (atomic transitions) to suspend ASR while keeping the audio stream alive; new `pausedAt` field on the Session resource
  - Publish `system/out/sessions/paused` and `system/out/sessions/resumed` MQTT events on transitions
  - Add `paused` value to the session status enum + new `pausedAt` column (migration)
  - Transcriber detects pause/resume from the retained status snapshot and drives ASR pause/resume with serialized transitions
  - Scheduler preserves a user-initiated pause across channel-driven recomputes and disconnects, and clears `pausedAt` when a lost transcriber forces a paused session back to `ready`
- Audio-only sessions (no transcriber profile)
  - Sessions/channels can run without a transcriber profile to capture audio only (e.g. for a later offline-transcription pipeline); the `-1` sentinel was replaced by `null`
  - Audio-only channels force uncompressed (WAV) audio at every creation site; re-assigning a real profile restores live transcription
- New ASR provider: Google Cloud Speech-to-Text
  - Streaming v1 provider (LINEAR16 16 kHz, service-account auth, multi-language, optional diarization, automatic stream restart around the 5-minute limit)
  - Session-API: `google` profile validation branch + self-contained `hasDiarization` (carried in the profile, no deployment env var) + Swagger enum/fields
- Transcriber reliability
  - Voxtral: drop the mid-session `input_audio_buffer.commit` that could freeze a stream ~10s at a RoPE re-anchor
  - Fix diarization + translation dual-recognizer mode producing an empty saved transcript — the primary is now a ConversationTranscriber that carries `speakerId`, and explicit primary/secondary origin-tagging replaces the fragile modulo-2 counter
  - Flush in-flight ASR finals before the end-of-stream marker on stop (bounded by timeout), so a reader after stop is guaranteed to see every caption
  - Epoch-isolate Amazon and Microsoft reconnects across `stop()`+`start()`; guard the Amazon reconnect against the stopping state
  - Microsoft ASR: fix the `startupTimeout` leak/race, stop emitting `closed` from the constructor, drop dead `pushStream` properties, set `CLOSED` synchronously after `pause()`, enrich STARTUP_TIMEOUT diagnostics
  - Never stamp a caption with a departed speaker; stop the `speakerTrackers` map from leaking; fix the startup race with an already-retained scheduler/status snapshot
  - BrokerClient keeps paused sessions across a transient snapshot loss
- Scheduler reliability
  - Fix a cross-channel session-status race that left a session stuck `active` with all channels inactive (real prod incident): take a `SELECT … FOR UPDATE` lock on the session row to serialize sibling-channel deactivations (also applied to `unregisterTranscriber`)
  - Serialize per-channel caption/translation/status persistence to match MQTT commit order, turning the end-of-stream marker and the `inactive` deactivate into true read barriers
  - Durable bot ownership: persist the owning BotService replica on the Bot row (survives a Scheduler restart) + reap orphaned Bot rows when a replica goes offline; weight bot routing by reported memory, not just active-bot count
- Session-API
  - Add `PUT /sessions/:id/stop?waitFinal=true` drain barrier: waits (bounded by `SESSION_STOP_FLUSH_TIMEOUT_MS`) until every channel is deactivated by its transcriber before returning; the non-opt-in path keeps the legacy immediate behaviour
  - Add `PUT /sessions/:id/clear` to wipe captions mid-session (small talk / equipment checks) without stopping; resets `lastSegmentId` and emits `system/out/sessions/cleared`
  - Always return 4xx errors as JSON `{error}`; require `force` to stop a paused session; apply the PATCH attribute whitelist to `PUT /sessions/:id`
  - Swagger: shared `ErrorResponse` schema, `operationId`s and accurate 4xx shapes
  - Publish `organizationId` and `visibility` in session broker messages
- Security
  - Session-API: SSRF guard on the meeting-bot URL — reject non-http(s) schemes and reserved/private/loopback/link-local hosts (IPv4 + IPv6) before creating a bot
  - Session-API: PATCH attribute whitelist (no direct status manipulation through the generic update endpoint); DELETE refuses paused sessions without `force=true` (previously only refused `active`)
  - Lib: new `enc:v2` HMAC-authenticated encryption format with deterministic wrong-key/tamper detection (removes the ~1/256 silent-garbage path), keeping `enc:v1` and legacy blobs readable; explicit `SECURITY_CRYPT_KEY` mismatch error
  - Harden inbound MQTT payload parsing in the Scheduler and Transcriber (skip empty/malformed messages instead of crashing the handler)
  - Transcriber: redact decrypted ASR provider keys from error logs
  - BotService: sanitize participant id/name in-page (defeats ANSI/newline log + caption-DB injection)
- Observability
  - Throttled, hot-loop-safe diagnostics on the previously-silent data paths: AudioMixer per-participant dropped-samples, TranscriberStream pre-ack dropped-frames, a bounded ring of recent SpeakerTracker assignment/grace events, and warnings on rejected MQTT control messages
- Bug fixes
  - Lib: fix CircularBuffer wrap-around corruption (`subarray` received a Uint8Array instead of integer indices); clamp oversize packets to the trailing N bytes instead of throwing `RangeError`
- Tests, CI and docs
  - New Mocha unit-test infrastructure across Transcriber, Session-API, Scheduler and BotService; `make test-all` / `test-unit*` targets; BotService unit tests run in CI
  - Containerized integration harness (strict `-euo pipefail`, fast-vs-slow split, single unified suite) with new scenarios: pause/resume (RTMP, WS, Microsoft; TCP vs UDP), native-diarization bot ingest, the real bot capture path, bot distribution across BotService replicas, and transcriber failover (scenario 16 + `docker-compose.failover.yml`)
  - CI: build the BotService image, add `staging/*` deploy stages, redeploy preprod on latest-unstable, move deploy SSH host/user to Jenkins credentials, skip the latest-unstable rebuild on CI/docs-only commits
  - Docs: `doc/production-topology.md` (Transcriber LB topology + failover), `doc/streaming-protocols.md` (TCP vs UDP pause/resume semantics), `MIGRATION.md`, pause/resume in the README and developer docs, and the BotService tunables

# 1.4.1

_2026_05_07_

- Fix Microsoft ASR returning pt-BR for pt-PT target
  - Map BCP47 codes to Azure-canonical locales (pt-pt, fr-ca, zh-Hans) at the SDK boundary
  - Preserve user-requested tags in MQTT payload keys
  - Extract translation helpers and add unit tests for Azure locale mapping, Microsoft transcriber, route controllers, and translation helpers

# 1.4.0

_2026_04_20_

- Captions storage refactor
  - Introduce dedicated `captions` and `translated_captions` tables (new migration)
  - Migrate Scheduler and Session-API read/write paths to the new tables
  - Drop legacy JSONB caption columns and optimize related queries
  - Harden transactional safety, fix N+1 queries, deduplicate caption formatting
  - Add `jsonb_typeof` guard for the `translatedCaptions` migration
- Translation payload changes
  - Refactor `translatedCaptions` from a flat array to a `segmentId`-keyed mapping
  - Strip translations from the main transcription MQTT payload
  - Add `mode` field to translation MQTT payloads (Transcriber and TranslatorPython)
  - Add final information on translation event (#27)
- MQTT
  - Downgrade QoS from 2 to 1 across all publish calls
- Swagger / API
  - Fix schema inconsistencies and document caption types
  - Move `translatedCaptions` next to `closedCaptions` in Session-API schema
- Tooling
  - Add mock MQTT message producer
  - Replace `npm install` with `npm ci` in Dockerfiles for deterministic builds
- Bug fixes
  - Fix error handling and stream stop in the ASR event emitter
  - Fix `TypeError` when iterating `targetLanguages` with external-only translations

# 1.3.2

_2026_03_26_

- Add channel turns pagination endpoint with organization and visibility support
- Remove channel timeout mechanism from RTMP and WebSocket servers

# 1.3.1

_2026_03_25_

- Fix segmentId continuity across ASR restarts: preserve segment numbering when an ASR instance is stopped and restarted within the same session (new migration, in-memory + DB tracking)

# 1.3.0

_2026_03_23_

- Add `user` visibility type for sessions, allowing per-user session scoping (new migration, API and Swagger updated)
- Fix reconnection race condition rejecting streaming clients with "Channel already active"
  - Replace stale MQTT-cached streamStatus check with local runningChannels state
  - Support same-transcriber reconnection (force-clean old worker) and cross-transcriber reconnection via load balancer
  - Guard against concurrent connection setup with pendingChannels Set
  - Bring RTMP and WebSocket servers to feature parity with SRT (runningChannels tracking, channel timeout, setSessions force-stop)
  - Scheduler safety: condition channel deactivation on transcriberId ownership to prevent stale overrides

# 1.2.1

_2026_03_18_

- Fix SRT memory leak: cache ReaderWriter per connection instead of creating a new native-bound object on every data event
- Optimize SRT→GStreamer IPC: use binary Buffer transfer instead of Array.from() serialization
- Fix native AsyncSRT leak: reuse shared instance for stream validation instead of creating one per connection
- Fix event listener leak: removeAllListeners on connection and worker during cleanup

# 1.2.0

_2026_03_11_

- Language improvements
  - Add flexible BCP47 language matching for ASR providers
  - Add language detection to LinTO ASR connector for translation support
  - Extract shared language detection module (franc-based) from OpenAI to reusable lang-detect utility
- MQTT and configuration
  - Add TLS/SSL support for MQTT broker connections
  - Add .env override support for easier environment customization
- LinTO Studio integration
  - Make integration paths configurable
  - Add websocket server env var and transcriber audio storage volume
  - Add SDK base URL, session API endpoint, and fix port overrides
  - Remove linto-studio submodule in favor of configurable paths
- Documentation
  - Update swagger with new translation schemas
- Bug fixes
  - Fix MQTT status always set to ERROR on publish
  - Fix segmentId dual counting and enable partials in Microsoft ASR
  - Fix FK onDelete for transcriberProfileId constraints (migration)
  - Fix channel ordering in API responses
  - Fix Sequelize ordering in sessions, templates, and transcriber profiles

# 1.1.0

_2026_02_24_

- New ASR provider: OpenAI Streaming Transcriber with Voxstral support
  - Pluggable protocol adapter for OpenAI Realtime API and vLLM-compatible endpoints
  - Client-side hybrid segmentation (word count, punctuation, silence detection)
  - Language detection via franc with caching
- External translation system
  - New Python-based Translator service replacing Node.js stub
  - Anti-flicker pipeline (change/sentence/stability gates)
  - TranslateGemma and echo providers, 24 EU languages support
  - Translation bus with segmentId correlation
  - Translator registry with dynamic profile injection
  - Punctuation-first segmentation for streaming transcription
- MQTT improvements
  - Keepalive and periodic status heartbeat
- Docker
  - Migrate Session-API, Scheduler and Migration images to Alpine
  - Translator Docker build added to Jenkins pipeline
  - CI variables integration in gitlab-ci
- Bug fixes
  - Fix critical SQL injections in Scheduler and Session-API
  - Centralize segmentId handling in ASR, remove duplication from providers
  - Fix Microsoft ASR missing language in mono mode, add 15s startup timeout
  - Fix auto-scheduling operator (Op.gt to Op.lte) for scheduleOn
  - Fix compressAudio/keepAudio undefined defaults causing 400 errors
  - Fix reconnection loops and error handling in LinTO and Microsoft transcribers
  - Fix transcriber profile save/load with expanded translation format
  - Fix FakeTranscriber crash when enableLiveTranscripts is false

# 1.0.0

_2026_01_30_

- Initial release of LinTO Studio Plugins
- Transcriber plugin
  - Support for Azure Speech Services with real-time transcription
  - Support for Amazon Transcribe streaming with IAM Roles Anywhere
  - Live transcription and translation capabilities
  - Multi-channel audio support
  - Custom metadata field for transcriber profiles
- Scheduler plugin
  - Job scheduling and management for transcription tasks
- Session-API plugin
  - REST API for session management
  - Encrypted API key storage
  - Swagger documentation
- Migration plugin
  - Database migration utilities
- Docker support with Node.js 22
- Jenkins CI/CD pipeline for automated builds
