# 1.3.2-hotfix.2

_2026_04_14_

- Downgrade MQTT QoS from 2 to 1 on all publishes, fixing translated caption loss under high target-language fan-out caused by broker in-flight window saturation (cherry-pick from `next`)
- Return `translatedCaptions` as a flat array on `GET /sessions/:id`, restoring compatibility with `studio-frontend:1.8.3`

# 1.3.2-hotfix.1

_2026_04_14_

- Normalize captions and translated captions into dedicated `captions` and `translated_captions` tables (INSERT-only), eliminating JSONB append O(n²) bloat on live sessions (cherry-pick from `next`)
- Harden transactional safety and fix N+1 queries in session/captions read paths
- Drop legacy `closedCaptions` and `translatedCaptions` JSONB columns on `channels` (irreversible migration)
- Fix ASR error handling and stream-stop events in Transcriber

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
