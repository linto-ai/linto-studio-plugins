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
