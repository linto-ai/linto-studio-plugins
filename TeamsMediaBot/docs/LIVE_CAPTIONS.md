# Live Captions - Teams Side Panel

Cette fonctionnalité permet d'afficher les transcriptions en temps réel dans un panneau latéral (side panel) pendant les réunions Microsoft Teams.

## Fonctionnalités

- **Temps réel** : Affichage instantané des transcriptions partielles et finales
- **Multi-locuteurs** : Identification des speakers (si supporté par l'ASR)
- **Traductions** : Affichage des traductions si configurées
- **Thèmes Teams** : Support des thèmes clair, sombre et contraste élevé
- **Auto-scroll** : Défilement automatique vers les nouvelles transcriptions
- **Reconnexion automatique** : Gestion des déconnexions réseau

## Architecture

```
┌─────────────┐     MQTT      ┌─────────────────────────────────────┐
│ Transcriber │──────────────►│         TeamsMediaBot               │
└─────────────┘               │                                     │
                              │  MqttService → TranscriptionHandler │
                              │                      │               │
                              │              CaptionsBroadcaster     │
                              │                      │               │
                              │              CaptionsHub (SignalR)   │
                              └──────────────────────┼───────────────┘
                                                     │
                                             SignalR WebSocket
                                                     │
┌─────────────────────────────────────────────────────┼───────────────┐
│  Teams Meeting                                      │               │
│  ┌─────────────────────────────┬────────────────────▼────────────┐  │
│  │    Main View                │        Side Panel (Tab)         │  │
│  │                             │   ┌──────────────────────────┐  │  │
│  │      👤  👤  👤             │   │  📝 Live Captions        │  │  │
│  │                             │   │  ─────────────────────── │  │  │
│  │                             │   │  [Jean] Bonjour à tous   │  │  │
│  │                             │   │  [Marie] Merci Jean...   │  │  │
│  │                             │   └──────────────────────────┘  │  │
│  └─────────────────────────────┴─────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

## Prérequis

- Node.js 18+ (pour builder le client React)
- .NET 6.0 SDK
- TeamsMediaBot configuré et fonctionnel
- Accès administrateur à Microsoft Teams (pour installer l'app)

## Installation

### 1. Builder le client React

```bash
cd TeamsMediaBot/client-app

# Installer les dépendances
npm install

# Builder l'application (output dans src/TeamsMediaBot/wwwroot/)
npm run build
```

### 2. Configurer le manifest Teams

Éditer `appManifest/manifest.json` et remplacer les placeholders :

| Placeholder | Description | Exemple |
|-------------|-------------|---------|
| `{{APP_ID}}` | GUID unique pour l'app | `a1b2c3d4-e5f6-7890-abcd-ef1234567890` |
| `{{BOT_DOMAIN}}` | Domaine public du bot | `bot.example.com` |
| `{{AAD_APP_ID}}` | ID de l'app Azure AD | `12345678-1234-1234-1234-123456789012` |

**Générer un GUID (PowerShell) :**
```powershell
[guid]::NewGuid().ToString()
```

**Générer un GUID (Bash) :**
```bash
uuidgen
```

### 3. Créer les icônes

Créer deux fichiers PNG dans le dossier `appManifest/` :

| Fichier | Dimensions | Description |
|---------|------------|-------------|
| `color.png` | 192x192 px | Icône couleur (fond coloré) |
| `outline.png` | 32x32 px | Icône contour (fond transparent) |

**Exemple avec ImageMagick :**
```bash
# Icône couleur (fond bleu avec texte)
convert -size 192x192 xc:#0078D4 -fill white -gravity center \
  -pointsize 48 -annotate 0 "CC" appManifest/color.png

# Icône outline (contour noir, fond transparent)
convert -size 32x32 xc:transparent -fill black -gravity center \
  -pointsize 16 -annotate 0 "CC" appManifest/outline.png
```

### 4. Packager l'application Teams

```bash
cd appManifest
zip -r LiveCaptions.zip manifest.json color.png outline.png
```

Ou sous Windows (PowerShell) :
```powershell
cd appManifest
Compress-Archive -Path manifest.json, color.png, outline.png -DestinationPath LiveCaptions.zip
```

### 5. Installer l'application dans Teams

#### Option A : Installation par l'administrateur (recommandé pour la production)

1. Aller dans le [Teams Admin Center](https://admin.teams.microsoft.com/)
2. Naviguer vers **Teams apps** > **Manage apps**
3. Cliquer sur **Upload new app**
4. Sélectionner `LiveCaptions.zip`
5. Configurer les permissions et politiques d'accès

#### Option B : Installation en mode développeur (pour les tests)

1. Dans Teams, cliquer sur **Apps** dans la barre latérale
2. Cliquer sur **Manage your apps** en bas
3. Cliquer sur **Upload an app**
4. Sélectionner **Upload a custom app**
5. Choisir `LiveCaptions.zip`

### 6. Ajouter l'app à une réunion

1. Rejoindre ou créer une réunion Teams
2. Cliquer sur **+** (Ajouter une app) dans la barre de réunion
3. Rechercher **Live Captions**
4. Cliquer sur **Add**
5. Le panneau latéral s'ouvre avec les captions

## Configuration

### Variables d'environnement

Aucune configuration supplémentaire n'est requise. La fonctionnalité utilise les mêmes paramètres que TeamsMediaBot.

### Endpoints exposés

| Endpoint | Méthode | Description |
|----------|---------|-------------|
| `/hubs/captions` | WebSocket | Hub SignalR pour les captions temps réel |
| `/api/captions/session` | GET | Obtenir les infos de session par threadId |
| `/api/captions/sessions` | GET | Lister toutes les sessions actives |
| `/configure.html` | GET | Page de configuration du tab |
| `/` | GET | Application React (side panel) |

### API Captions

**Obtenir une session par threadId :**
```http
GET /api/captions/session?threadId=19:meeting_xxx@thread.v2
```

Réponse :
```json
{
  "sessionId": "123",
  "channelId": "456",
  "threadId": "19:meeting_xxx@thread.v2",
  "enableDisplaySub": true
}
```

**Lister les sessions actives :**
```http
GET /api/captions/sessions
```

Réponse :
```json
[
  {
    "sessionId": "123",
    "channelId": "456",
    "threadId": "19:meeting_xxx@thread.v2",
    "enableDisplaySub": true
  }
]
```

## Développement

### Lancer le client en mode développement

```bash
cd client-app
npm run dev
```

Le serveur de développement Vite démarre sur `http://localhost:3000` avec proxy vers le backend.

### Tester sans Teams

Pour tester hors de Teams, utiliser les paramètres URL :

```
http://localhost:3000/?sessionId=123&channelId=456
```

Ou avec un threadId :
```
http://localhost:3000/?threadId=19:meeting_xxx@thread.v2
```

### Structure du projet client

```
client-app/
├── src/
│   ├── components/
│   │   ├── CaptionsPanel.tsx    # Composant principal des captions
│   │   └── CaptionsPanel.css    # Styles du composant
│   ├── hooks/
│   │   ├── useTeamsContext.ts   # Hook pour TeamsJS SDK
│   │   └── useSignalR.ts        # Hook pour connexion SignalR
│   ├── App.tsx                  # Application principale
│   ├── App.css                  # Styles globaux
│   ├── types.ts                 # Types TypeScript
│   └── main.tsx                 # Point d'entrée
├── public/
│   └── configure.html           # Page de configuration Teams
├── index.html                   # HTML principal
├── package.json
├── tsconfig.json
└── vite.config.ts
```

## Dépannage

### Le side panel affiche "Waiting for transcriptions..."

**Causes possibles :**
1. Le bot de transcription n'a pas encore rejoint la réunion
2. Le threadId ne correspond à aucune session active

**Solutions :**
1. Vérifier que le bot a rejoint la réunion (voir les logs TeamsMediaBot)
2. Vérifier `/api/captions/sessions` pour voir les sessions actives

### Erreur "Unable to get meeting context from Teams"

**Cause :** L'app n'est pas dans le contexte d'une réunion Teams.

**Solutions :**
1. S'assurer que l'app est ouverte depuis une réunion Teams
2. Vérifier que le manifest inclut `meetingSidePanel` dans les contexts

### SignalR ne se connecte pas

**Causes possibles :**
1. CORS mal configuré
2. Certificat SSL invalide
3. Pare-feu bloquant les WebSockets

**Solutions :**
1. Vérifier les logs du serveur pour les erreurs CORS
2. S'assurer que le certificat SSL est valide ou utiliser `BrokerAllowUntrustedCertificates=true` pour le dev
3. Ouvrir le port du bot dans le pare-feu

### Les captions ne s'affichent pas en temps réel

**Cause :** Le TranscriptionHandler ne reçoit pas les transcriptions.

**Solutions :**
1. Vérifier la connexion MQTT avec le Transcriber
2. Vérifier les logs pour `[TeamsMediaBot] Transcription for session`
3. S'assurer que `enableDisplaySub=true` dans le payload startbot

## Logs utiles

```
# Connexion SignalR client
[CaptionsHub] Client connected: xxx
[CaptionsHub] Client xxx joined group 123_456

# Broadcast des captions
[CaptionsBroadcaster] Sent final caption to group 123_456: Bonjour à tous

# Réception des transcriptions
[TeamsMediaBot] Transcription for session 123: Bonjour à tous
```

## Limitations connues

1. **Largeur fixe** : Le side panel Teams fait 320px de large, l'UI est optimisée pour cette taille
2. **Pas de persistance** : Les captions ne sont pas sauvegardées, elles disparaissent si on ferme le panel
3. **Une session par réunion** : Le bot ne peut rejoindre qu'une seule session par réunion
4. **Délai réseau** : Un léger délai (< 1 seconde) est possible selon la latence réseau
