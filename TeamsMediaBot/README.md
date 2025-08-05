# Teams Media Bot (.NET Framework 4.8)

This service joins Microsoft Teams meetings as a bot and forwards raw audio frames to an external SRT (Secure Reliable Transport) receiver. The service uses Microsoft Graph Communications APIs to interact with Teams meetings and libsrt for audio streaming.

**🚀 MAJOR UPDATE**: Converted to .NET Framework 4.8 for full Microsoft Graph Communications SDK compatibility!

## Architecture Overview

### Two Azure Components Required

This bot requires **TWO separate Azure components** that work together:

```
Teams Meeting → Azure Bot Service → Your Webhook → Microsoft Graph API ← Azure AD App
```

#### 1. **Azure AD Application** (Identity & Permissions)
- **Purpose**: Authentication and permissions for Microsoft Graph API
- **App ID**: Your application client ID
- **Secret**: Client secret for authentication
- **Permissions**: Calls.*, OnlineMeetings.*, Calendars.*
- **Role**: "Identity card" for Microsoft Graph access

#### 2. **Azure Bot Service** (Teams Communication)
- **Purpose**: Receives events and invitations from Microsoft Teams
- **Bot Handle**: Unique bot name (e.g., `linto-teams-bot`)
- **App ID**: **SAME** as Azure AD Application
- **Messaging Endpoint**: Your HTTPS webhook URL
- **Role**: "Phone number" for Teams to contact your bot

### Why Both Are Needed
- **Azure AD App** handles authentication with Microsoft Graph API
- **Azure Bot Service** handles communication with Microsoft Teams
- They share the same App ID but serve different purposes
- Without Azure Bot Service, Teams cannot send events to your bot
- Without Azure AD App, your bot cannot authenticate with Microsoft Graph

## Requirements
- **.NET Framework 4.8** (required for Communications SDK)
- **Windows OS** (Communications SDK requires Windows Media Foundation)
- **libsrt shared library** available at runtime
- **HTTPS endpoint** for webhook (use ngrok for local testing)
- **Azure Bot Service** registration
- **Azure AD Application** with proper permissions
- **IIS or OWIN self-hosting** capability

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
| `LOG_FORMAT` | Log output format: `json` or `human` (default: `human`) |

## Endpoints
- `POST /api/bot/join` – body `{ "joinUrl": "<Teams join URL>" }`
- `GET /api/bot/test-connection` – test Microsoft Graph connection
- `GET /health` – health check
- `POST /api/messages` – webhook endpoint for Azure Bot Service

## Running

### Development (.NET Framework 4.8)
```bash
# Build the project
dotnet build

# Run with OWIN self-hosting
dotnet run --project BotService

# With JSON logs (for production/monitoring)
set LOG_FORMAT=json
dotnet run --project BotService

# With human-readable logs (default for development)
set LOG_FORMAT=human
dotnet run --project BotService
```

### Production (IIS Deployment)
1. Build the project: `dotnet build --configuration Release`
2. Publish to IIS: Copy `bin/` and web files to IIS application folder
3. Configure IIS application pool for .NET Framework 4.8
4. Set environment variables in web.config or IIS configuration

### Log Formats

The service supports two log formats:

- **Human-readable format** (default): Clean, colored output for developers
  ```
  [00:54:08.601 INF] Lifetime: Now listening on: "http://localhost:5113"
  [00:54:08.611 INF] Lifetime: Application started. Press Ctrl+C to shut down.
  ```

- **JSON format**: Structured logs for production monitoring tools
  ```json
  {"Timestamp":"2025-08-05T00:56:06.377Z","Level":"Information","MessageTemplate":"Now listening on: {address}","Properties":{"address":"http://localhost:5113"}}
  ```

## Testing Setup

### 1. Local HTTPS Tunnel
```bash
# Install ngrok
npm install -g ngrok

# Create HTTPS tunnel
ngrok http 5113

# Use the HTTPS URL (e.g., https://abc123.ngrok.io) as your messaging endpoint
```

### 2. Test Endpoints
```bash
# Health check
curl https://your-tunnel.ngrok.io/health

# Test Graph connection
curl https://your-tunnel.ngrok.io/api/bot/test-connection
```

## Docker (Windows Containers)
**Note**: Since the service now requires .NET Framework 4.8 and Windows Media Foundation, it must run on Windows containers:

```dockerfile
FROM mcr.microsoft.com/dotnet/framework/aspnet:4.8-windowsservercore-ltsc2019
# Docker configuration for Windows containers
```

## Tests
```bash
dotnet test
```

## Azure Setup Guide

### Step 1: Create Azure AD Application

1. **Azure Portal** → **Entra ID** → **App registrations** → **New registration**
   - **Name**: LinTO Bot
   - **Supported account types**: Single tenant (your organization only)
   - **Redirect URI**: Leave blank

2. **Generate Client Secret**
   - Go to **Certificates & secrets** → **New client secret**
   - Save the secret value immediately (shown only once)

3. **Configure Permissions**
   - Go to **API permissions** → **Add a permission** → **Microsoft Graph**
   - **Application permissions**:
     - `Calendars.ReadWrite.All`
     - `Calls.JoinGroupCall.All`
     - `Calls.InitiateGroupCall.All`
     - `OnlineMeetings.Read.All`
   - **Delegated permissions**:
     - `Calendars.ReadWrite`
   - **Grant admin consent** for your tenant

### Step 2: Create Azure Bot Service

1. **Azure Portal** → **Create a resource** → Search "Azure Bot"
2. **Bot Configuration**:
   - **Bot handle**: `linto-teams-bot` (must be globally unique)
   - **Subscription**: Your subscription
   - **Resource group**: Create new or use existing
   - **Microsoft App ID**: **Use existing** → Enter your Azure AD App ID
   - **App Type**: Single tenant
3. **Configure Messaging Endpoint**:
   - Go to **Configuration** → Set **Messaging endpoint** to `https://your-domain.com/api/messages`
   - For testing: Use ngrok HTTPS URL
4. **Enable Teams Channel**:
   - Go to **Channels** → **Microsoft Teams** → **Apply**

### Step 3: Create Teams App (Optional)

For advanced scenarios, create a Teams app manifest in **Teams Developer Portal**:
- Use the same App ID as your Azure AD Application
- Configure bot capabilities and permissions

## Troubleshooting

### Common Issues

1. **Graph API connection fails**
   - Verify admin consent granted for application permissions
   - Check tenant ID, client ID, and secret are correct
   - Ensure application permissions (not delegated) are used

2. **No Teams events received**
   - Verify Azure Bot Service is created with correct App ID
   - Check messaging endpoint is HTTPS and publicly accessible
   - Ensure Teams channel is enabled in Azure Bot Service

3. **Webhook endpoint not reachable**
   - Use ngrok or deploy to cloud for HTTPS endpoint
   - Verify firewall settings allow inbound HTTPS traffic
   - Test endpoint accessibility from external networks

### Verification Steps

```bash
# 1. Test service is running
curl https://your-endpoint/health

# 2. Test Graph API authentication
curl https://your-endpoint/api/bot/test-connection

# 3. Test webhook endpoint (should return 405 Method Not Allowed for GET)
curl https://your-endpoint/api/messages
```
