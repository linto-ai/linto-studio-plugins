# TeamsAppService

Service Node.js pour afficher les transcriptions en temps réel dans un panneau latéral Microsoft Teams.

## Architecture

```
TeamsAppService/
├── components/
│   ├── MeetingRegistry/     # Registre en mémoire threadId → session/channel
│   ├── BrokerClient/        # Client MQTT pour événements et transcriptions
│   ├── WebServer/           # Serveur Express (API REST + fichiers statiques)
│   │   ├── public/          # Frontend Teams App
│   │   │   ├── css/
│   │   │   ├── js/
│   │   │   └── manifest/    # Manifest et icônes Teams
│   │   └── routes/
│   │       ├── api.js       # Endpoints REST
│   │       └── manifest.js  # Génération du package ZIP
│   └── WebSocketServer/     # Socket.IO pour temps réel
├── teamsappservice.js       # Point d'entrée
├── Dockerfile
└── README.md
```

## Configuration

### Variables d'environnement

| Variable | Description | Défaut |
|----------|-------------|--------|
| `TEAMSAPPSERVICE_COMPONENTS` | Composants à charger | `MeetingRegistry,BrokerClient,WebServer,WebSocketServer` |
| `TEAMSAPPSERVICE_HTTP_PORT` | Port du serveur HTTP | `8082` |
| `TEAMSAPPSERVICE_APP_ID` | ID de l'application Azure AD | `00000000-0000-0000-0000-000000000000` |
| `TEAMSAPPSERVICE_BASE_URL` | URL publique du service | `https://emeeting.example.com` |
| `BROKER_HOST` | Hôte MQTT | `broker` |
| `BROKER_PORT` | Port MQTT | `1883` |

## API REST

### GET /v1/meetings/:threadId

Récupère les informations d'un meeting par son threadId Teams.

**Réponse:**
```json
{
  "threadId": "19:meeting_xxx@thread.v2",
  "sessionId": "uuid",
  "channelId": "uuid",
  "joinedAt": "2024-01-15T10:30:00Z"
}
```

### GET /v1/meetings

Liste tous les meetings actifs.

### GET /v1/status

État du service.

### GET /healthcheck

Health check pour Docker.

## Package Teams App

### Téléchargement automatique

Le package ZIP est généré automatiquement avec les variables d'environnement remplacées:

```
GET /manifest/package.zip
```

Le ZIP contient:
- `manifest.json` - Manifest avec variables remplacées
- `color.png` - Icône couleur 192x192
- `outline.png` - Icône contour 32x32

### Informations du manifest

```
GET /manifest/info
```

**Réponse:**
```json
{
  "appId": "00000000-0000-0000-0000-000000000000",
  "baseUrl": "https://emeeting.example.com",
  "domain": "emeeting.example.com",
  "downloadUrl": "https://emeeting.example.com/manifest/package.zip"
}
```

### Icônes personnalisées

Pour utiliser vos propres icônes, placez-les dans:
```
components/WebServer/public/manifest/
├── color.png      # 192x192 pixels, icône couleur
└── outline.png    # 32x32 pixels, contour transparent
```

Si les fichiers n'existent pas, des icônes placeholder sont générées automatiquement.

## Installation dans Teams

### 1. Configurer l'application Azure AD

1. Allez sur [Azure Portal](https://portal.azure.com)
2. Créez une nouvelle inscription d'application
3. Notez l'**Application (client) ID**
4. Configurez les permissions nécessaires

### 2. Configurer les variables d'environnement

```bash
TEAMSAPPSERVICE_APP_ID=<votre-app-id>
TEAMSAPPSERVICE_BASE_URL=https://votre-domaine.com
```

### 3. Télécharger le package

```bash
curl -o teams-app.zip https://votre-domaine.com/manifest/package.zip
```

### 4. Installer dans Teams

**Option A: Teams Developer Portal (développement)**
1. Allez sur https://dev.teams.microsoft.com
2. Apps → Import app
3. Uploadez `teams-app.zip`

**Option B: Teams Admin Center (production)**
1. Allez sur https://admin.teams.microsoft.com
2. Teams apps → Manage apps
3. Upload new app

**Option C: Sideload (test)**
1. Dans Teams, cliquez sur Apps
2. Manage your apps → Upload an app
3. Sélectionnez `teams-app.zip`

## Communication MQTT

### Topics écoutés

| Topic | Description |
|-------|-------------|
| `teamsappservice/in/meeting-joined` | Bot a rejoint un meeting |
| `teamsappservice/in/meeting-left` | Bot a quitté un meeting |
| `transcriber/out/{sessionId}/{channelId}/partial` | Transcription partielle |
| `transcriber/out/{sessionId}/{channelId}/final` | Transcription finale |

### Payload meeting-joined

```json
{
  "sessionId": "uuid",
  "channelId": "uuid",
  "threadId": "19:meeting_xxx@thread.v2",
  "joinedAt": "2024-01-15T10:30:00Z"
}
```

## WebSocket (Socket.IO)

### Événements client → serveur

| Événement | Payload | Description |
|-----------|---------|-------------|
| `join` | `{ sessionId, channelId }` | Rejoindre une room de transcription |
| `leave` | `{ sessionId, channelId }` | Quitter une room |

### Événements serveur → client

| Événement | Payload | Description |
|-----------|---------|-------------|
| `partial` | `{ speaker, text, timestamp }` | Transcription en cours |
| `final` | `{ speaker, text, timestamp }` | Transcription finalisée |
| `brokerStatus` | `{ connected: boolean }` | État du broker MQTT |

## Développement

### Lancer en local

```bash
cd TeamsAppService
npm install
npm run dev
```

### Docker

```bash
docker-compose up teamsappservice
```

### Test sans Teams

Ouvrez dans un navigateur:
```
http://localhost:8082/teams-app-tab.html?sessionId=xxx&channelId=yyy
```

## Flux de données

```
┌─────────────────┐     MQTT      ┌──────────────────┐
│  TeamsMediaBot  │──────────────►│ TeamsAppService  │
│                 │ meeting-joined│                  │
│                 │ meeting-left  │  MeetingRegistry │
└─────────────────┘               └────────┬─────────┘
                                           │
┌─────────────────┐     MQTT               │ Socket.IO
│   Transcriber   │──────────────►─────────┤
│                 │  partial/final         │
└─────────────────┘               ┌────────▼─────────┐
                                  │   Teams App      │
                                  │  (Side Panel)    │
                                  └──────────────────┘
```
