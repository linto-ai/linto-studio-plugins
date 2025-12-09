# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

E-Meeting is a microservices-based platform for real-time meeting transcription with multilingual support. It connects multiple ASR providers to transcribe meetings and provides live closed captions and downloadable transcripts. The platform also supports Microsoft Teams integration for automated meeting transcription.

## Architecture

The system consists of several Docker-containerized microservices:

### Core Services

1. **Session-API** - REST API for managing transcription sessions (Swagger UI at http://localhost:8000/api-docs/)
   - Express.js 4.21.2 web framework
   - Manages sessions, channels, transcriber profiles, templates, and bots
   - Exposes endpoints: `/v1/sessions`, `/v1/transcriber_profiles`, `/v1/templates`, `/v1/bots`, `/v1/msteams/users`
   - Communicates with other services via MQTT

2. **Transcriber** - Handles audio streaming and ASR provider connections
   - Receives audio via SRT (UDP 8889), RTMP (TCP 1935), WebSocket (TCP 8890)
   - Supports multiple ASR providers: Microsoft Azure, Amazon Transcribe, LinTO, Fake
   - Uses GStreamer for audio transcoding to S16LE PCM 16kHz mono
   - Publishes transcriptions to MQTT broker

3. **Scheduler** - Central orchestration service
   - Coordinates transcribers and bot services via MQTT
   - Manages automatic session start/end scheduling
   - Handles transcriber failover and session assignment
   - Saves transcriptions to database

4. **Migration** - Database migration service using Sequelize
   - 18 migrations defining 8 database tables
   - Must run before other services start

5. **Database** - PostgreSQL database

6. **Broker** - MQTT message broker (Eclipse Mosquitto)

### Microsoft Teams Integration Services

7. **Microsoft-Teams-Scheduler** - Orchestrates Teams calendar events
   - Receives webhooks from Microsoft Graph API for calendar events
   - Stores Teams users and events in PostgreSQL
   - Triggers transcription via MQTT when meetings start
   - Port: 8081

8. **TeamsMediaBot** - .NET Framework 4.8 bot for Teams meetings
   - Joins Teams meetings and captures raw audio
   - Streams audio via WebSocket to Transcriber
   - Requires Windows (uses Windows Media Foundation)
   - Integrates as a Teams app tab
   - Port: 5113

### Bot Services

9. **BotService** - Automated meeting participant for Jitsi/BigBlueButton
   - Uses Puppeteer with headless Chromium to join meetings
   - Captures audio and streams to Transcriber via WebSocket
   - Displays live captions via virtual webcam
   - Supports Jitsi and BigBlueButton platforms

### Shared Library

10. **lib** (live-srt-lib) - Shared utilities used across all Node.js services
    - `Application` & `Component` classes for service architecture
    - `MqttClient` for MQTT communication
    - `Model` (Sequelize) for database access
    - `CircularBuffer` for audio buffering
    - `Security` for AES-256-CBC encryption
    - `Config` for environment variable management
    - `logger` (Winston) for structured logging

### Optional Integration

- **LinTO Studio** - Full-featured UI as a git submodule

## Common Commands

### Local Development
```bash
# Install all dependencies (run in root, lib, and each module)
make install-local

# Run migrations and start services locally
make run-dev

# Run specific service with debug logs
DEBUG=session-api:* npm run start:session-api
DEBUG=transcriber:* npm run start:transcriber
DEBUG=scheduler:* npm run start:scheduler
DEBUG=msteams-scheduler:* npm start  # In Microsoft-Teams-Scheduler directory
```

### Docker Development
```bash
# Build and run with Docker Compose
make run-docker-dev

# Stop services
make stop-docker-dev

# Remove containers
make down-docker-dev

# With LinTO Studio integration
make run-docker-dev-linto-studio
```

### Testing
```bash
# Unit tests (Transcriber circular buffer)
cd Transcriber && npm test

# Integration tests (requires .envtest file)
./integration-test.sh

# Integration tests for CI
./integration-test-ci.sh

# TeamsMediaBot tests
cd TeamsMediaBot && dotnet test
```

### Database Operations
```bash
# Run migrations
make migrate

# Encrypt API keys
cd Session-API && npm run encrypt-keys -- SECURITY_CRYPT_KEY=<key> SECURITY_SALT_FILEPATH=<path>

# Migrate encryption keys
cd Session-API && npm run migrate-keys -- OLD_SECURITY_CRYPT_KEY=<key> NEW_SECURITY_CRYPT_KEY=<key>
```

## Key Configuration Files

- `.env` - Main environment configuration (create from .envdefault.docker)
- `.envdefault` - Default environment variables for local development
- `.envdefault.docker` - Default Docker environment variables
- `compose.yml` - Base Docker Compose configuration
- `compose.override.yml` - Local development overrides
- `compose.prod.yml` - Production configuration with HTTPS
- `compose.linto-studio.yml` - LinTO Studio integration

## Database Schema

The database contains 8 tables managed by Sequelize:

| Table | Purpose |
|-------|---------|
| `transcriberProfiles` | ASR provider configurations |
| `sessions` | Transcription sessions |
| `channels` | Audio channels within sessions |
| `sessionTemplates` | Reusable session configurations |
| `channelTemplates` | Reusable channel configurations |
| `bots` | Bot configurations (Jitsi/BBB) |
| `msTeamsUsers` | Microsoft Teams user mappings |
| `msTeamsEvents` | Teams calendar events |

**Session statuses:** `on_schedule`, `ready`, `active`, `terminated`
**Channel stream statuses:** `active`, `inactive`, `errored`
**Bot providers:** `jitsi`, `bigbluebutton`

## ASR Provider Integration

ASR providers are located in `Transcriber/ASR/`. Currently supports:

| Provider | Features | Configuration |
|----------|----------|---------------|
| **Microsoft Azure** | Multi-language, translation, diarization, custom endpoints | `region`, `key`, `languages` |
| **Amazon Transcribe** | Streaming, diarization, IAM Roles Anywhere auth | `region`, `credentials`, ARNs |
| **LinTO** | WebSocket-based, custom endpoints | `languages[].endpoint` |
| **Fake** | Testing purposes, no-op | `languages` |

### Adding a New ASR Provider

1. Create folder in `Transcriber/ASR/[provider-name]/`
2. Create `index.js` exporting a class extending EventEmitter
3. Implement required methods: `start()`, `stop()`, `transcribe(buffer)`
4. Emit required events: `connecting`, `ready`, `closed`, `transcribing`, `transcribed`, `error`
5. Add environment variables in `.envdefault`:
   - `ASR_AVAILABLE_TRANSLATIONS_[PROVIDER]`
   - `ASR_HAS_DIARIZATION_[PROVIDER]`

## Audio Streaming Protocols

| Protocol | Port | Usage |
|----------|------|-------|
| **SRT** | UDP 8889 | Primary, low-latency broadcast streaming |
| **RTMP** | TCP 1935 | Traditional streaming (OBS, FFmpeg) |
| **WebSocket** | TCP 8890 | Web-based clients, bots |

**Audio format:** PCM S16LE, 16kHz, mono (32,000 bytes/sec)

## MQTT Topics

### Transcriber
- `transcriber/out/{sessionId}/{channelId}/partial` - Partial transcriptions
- `transcriber/out/{sessionId}/{channelId}/final` - Final transcriptions
- `transcriber/out/{uniqueId}/status` - Transcriber status

### Scheduler
- `scheduler/in/startbot` - Start bot command
- `scheduler/in/stopbot` - Stop bot command
- `system/out/sessions/statuses` - Active sessions list

### BotService
- `botservice/in/startbot` - Start bot command
- `botservice/out/{uniqueId}/status` - Bot service status

## Important Environment Variables

### Core Configuration
```bash
DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME  # PostgreSQL
BROKER_HOST, BROKER_PORT, BROKER_USERNAME, BROKER_PASSWORD  # MQTT
SECURITY_CRYPT_KEY, SECURITY_SALT_FILEPATH  # API key encryption
```

### Streaming Configuration
```bash
STREAMING_PROTOCOLS=SRT,RTMP,WS  # Active protocols
STREAMING_SRT_UDP_PORT=8889
STREAMING_RTMP_TCP_PORT=1935
STREAMING_WS_TCP_PORT=8890
STREAMING_PASSPHRASE=A0123456789  # SRT encryption (10+ chars)
```

### Audio Configuration
```bash
MAX_AUDIO_BUFFER=10  # Seconds to buffer if ASR offline
MIN_AUDIO_BUFFER=200  # Milliseconds before sending to ASR
SAMPLE_RATE=16000  # Hz
BYTES_PER_SAMPLE=2  # 16-bit
```

### Microsoft Teams Configuration
```bash
MSTEAMS_SCHEDULER_AZURE_TENANT_ID  # Azure AD tenant
MSTEAMS_SCHEDULER_AZURE_CLIENT_ID  # App client ID
MSTEAMS_SCHEDULER_AZURE_CLIENT_SECRET  # App secret
MSTEAMS_SCHEDULER_USER_ID  # Default user to monitor
MSTEAMS_SCHEDULER_PUBLIC_BASE  # Public webhook URL
```

### TeamsMediaBot Configuration (Windows only)
```bash
AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET  # Azure AD auth
BOT_BASE_URL  # Public URL for callbacks (e.g., ngrok)
```

## API Workflow

1. Create transcriber profile via POST `/v1/transcriber_profiles`
2. Create session with channels via POST `/v1/sessions`
3. Get streaming endpoint from session details (`streamEndpoints`)
4. Stream audio to endpoint (SRT/RTMP/WebSocket)
5. Receive real-time transcriptions via MQTT broker
6. Optionally create bots for automated meeting joining

## Project Structure Notes

- Each service has its own Dockerfile and docker-entrypoint.sh
- The `lib` folder contains shared utilities used across services
- All services must be built from repository root: `docker build -f [Service]/Dockerfile .`
- Services communicate via MQTT broker for event-driven architecture
- Node.js services use the Component pattern from `live-srt-lib`
- TeamsMediaBot is .NET Framework 4.8 (Windows only)

## Service Dependencies

```
PostgreSQL ← Migration (runs first)
         ↓
    All services depend on:
    - Database (PostgreSQL)
    - Broker (MQTT Mosquitto)
         ↓
Session-API ← User requests
Scheduler ← Orchestration
Transcriber ← Audio processing
Microsoft-Teams-Scheduler ← Teams webhooks
BotService ← Meeting automation
TeamsMediaBot ← Teams audio capture
```

## Commit Guidelines

- When making a commit, follow this naming convention:
  - Commit name format: `[SERVICE_NAME] short description`
  - Commit log should briefly explain what the patch does
  - Examples: `[Session-API] Add pagination to sessions endpoint`, `[Transcriber] Fix Azure reconnection`

## Additional Git Guidelines

- Do not include Claude's name in the commit log or as a co-author when committing code
