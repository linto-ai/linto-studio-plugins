# Teams Media Bot

This service joins Microsoft Teams meetings and forwards raw audio frames to an external SRT receiver.

## Requirements
- .NET 8 SDK
- libsrt shared library available at runtime

## Configuration
Configuration is provided via environment variables:

| Variable | Description |
|---|---|
| `AZURE_TENANT_ID` | Azure AD tenant ID |
| `AZURE_CLIENT_ID` | Application (client) ID |
| `AZURE_CLIENT_SECRET` | Client secret |
| `SRT_HOST` | Hostname of SRT receiver |
| `SRT_PORT` | Port of SRT receiver |
| `SRT_LATENCY` | Latency in milliseconds |
| `SRT_STREAM_ID` | Stream ID |

## Endpoints
- `POST /api/bot/join` – body `{ "joinUrl": "<Teams join URL>" }`
- `GET /health` – health check

## Running
```bash
dotnet build
DOTNET_ENVIRONMENT=Production dotnet run --project BotService
```

## Docker
A simple Dockerfile is included. Build and run with Docker:
```bash
docker build -t teams-bot -f BotService.Dockerfile .
docker run -e AZURE_TENANT_ID=... -e AZURE_CLIENT_ID=... -e AZURE_CLIENT_SECRET=... teams-bot
```

## Tests
```
dotnet test
```
