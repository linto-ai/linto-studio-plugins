# TeamsMediaBot - Guide de Configuration Complet

Bot Microsoft Teams pour capturer l'audio des réunions et le streamer vers un service de transcription.

## Table des matières

1. [Architecture](#architecture)
2. [Prérequis](#prérequis)
3. [Configuration Azure](#configuration-azure)
   - [App Registration (Entra ID)](#1-app-registration-entra-id)
   - [Azure Bot](#2-azure-bot)
4. [Configuration du Serveur Windows](#configuration-du-serveur-windows)
   - [VM Azure](#vm-azure)
   - [Certificat SSL](#certificat-ssl)
   - [Pare-feu et NSG](#pare-feu-et-nsg)
5. [Configuration de l'Application](#configuration-de-lapplication)
6. [Lancer les Services](#lancer-les-services)
7. [Utilisation de l'API](#utilisation-de-lapi)
8. [Intégration MQTT avec le Scheduler](#intégration-mqtt-avec-le-scheduler)
9. [Dépannage](#dépannage)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Azure VM Windows                               │
│                                                                             │
│   ┌─────────────────────────────┐                                          │
│   │       TeamsMediaBot         │                                          │
│   │      (ports 9441/9442)      │                                          │
│   │                             │                                          │
│   │  • Rejoint les meetings     │                                          │
│   │  • Capture l'audio Teams    │                                          │
│   │  • Stream vers Transcriber  │                                          │
│   │  • Reçoit commandes MQTT    │                                          │
│   └──────────────┬──────────────┘                                          │
│                  │                                                          │
│                  ▼                                                          │
│     ┌─────────────────────────┐                                            │
│     │      MQTT Broker        │                                            │
│     │  (Transcriptions, Cmds) │                                            │
│     └─────────────────────────┘                                            │
└─────────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
                    ┌─────────────────────────┐
                    │       Transcriber       │
                    │   (Audio → Texte ASR)   │
                    └─────────────────────────┘
```

### Flux de données

1. **Scheduler** envoie commande `startbot` via MQTT
2. **TeamsMediaBot** rejoint la réunion Teams et capture l'audio
3. **TeamsMediaBot** stream l'audio vers le **Transcriber** (WebSocket)
4. **Transcriber** publie les transcriptions sur MQTT (`transcriber/out/{session}/{channel}/...`)

---

## Prérequis

### Logiciels requis

| Logiciel | Version | Notes |
|----------|---------|-------|
| Windows | 10/11 ou Server 2019+ | Requis pour Windows Media Foundation |
| .NET SDK | 6.0+ | `winget install Microsoft.DotNet.SDK.6` |
| Git | Dernière | `winget install Git.Git` |

### Infrastructure requise

- **VM avec 2+ cores physiques** - Le Media Platform Microsoft requiert au minimum 2 cores physiques
- **IP publique statique** - Pour les callbacks de Microsoft Teams
- **Nom DNS** - FQDN pointant vers l'IP publique (ex: `bot.example.com`)
- **Certificat SSL valide** - Pour HTTPS (Let's Encrypt fonctionne)
- **Tenant Microsoft 365** - Avec droits admin pour les App Registrations

---

## Configuration Azure

### 1. App Registration (Entra ID)

#### Créer l'Application

1. Aller sur [Azure Portal](https://portal.azure.com) > **Microsoft Entra ID** > **App registrations**
2. Cliquer **New registration**
3. Configurer :
   - **Name** : `TeamsMediaBot` (ou autre nom descriptif)
   - **Supported account types** : `Accounts in this organizational directory only (Single tenant)`
   - **Redirect URI** : Laisser vide
4. Cliquer **Register**

#### Noter les identifiants

Après création, noter :

| Paramètre | Où le trouver | Variable .env |
|-----------|---------------|---------------|
| Application (client) ID | Page Overview | `AppSettings__AadAppId` |
| Directory (tenant) ID | Page Overview | (pour référence) |

#### Créer un Secret

1. Aller dans **Certificates & secrets** > **Client secrets**
2. Cliquer **New client secret**
3. Description : `TeamsMediaBot Secret`
4. Expiration : Choisir selon vos besoins (24 mois max)
5. **Copier immédiatement la Value** (visible une seule fois)

| Paramètre | Variable .env |
|-----------|---------------|
| Secret Value | `AppSettings__AadAppSecret` |

#### Configurer les Permissions API

1. Aller dans **API permissions** > **Add a permission**
2. Sélectionner **Microsoft Graph** > **Application permissions**
3. Ajouter ces permissions :

| Permission | Description | Obligatoire |
|------------|-------------|-------------|
| `Calls.AccessMedia.All` | Accéder aux flux média des appels | Oui |
| `Calls.JoinGroupCall.All` | Rejoindre des appels de groupe | Oui |
| `Calls.JoinGroupCallAsGuest.All` | Rejoindre en tant qu'invité | Optionnel |

4. Cliquer **Grant admin consent for [Tenant]** (nécessite droits admin)
5. Vérifier que toutes les permissions ont le statut vert "Granted"

### 2. Azure Bot

#### Créer le Bot

1. Aller sur [Azure Portal](https://portal.azure.com) > **Create a resource**
2. Rechercher **Azure Bot** > **Create**
3. Configurer :

| Paramètre | Valeur |
|-----------|--------|
| Bot handle | Nom unique (ex: `teamsmediabot-prod`) |
| Subscription | Votre abonnement Azure |
| Resource group | Créer ou utiliser existant |
| Data residency | Global ou région préférée |
| Pricing tier | Standard (pour production) |
| Type of App | Single Tenant |
| Creation type | **Use existing app registration** |
| App ID | L'Application ID créé à l'étape précédente |
| App tenant ID | Votre Directory (tenant) ID |

4. Cliquer **Review + create** puis **Create**

#### Configurer le Messaging Endpoint

1. Aller dans la ressource Azure Bot créée
2. Aller dans **Configuration**
3. Configurer :

| Paramètre | Valeur |
|-----------|--------|
| Messaging endpoint | `https://VOTRE_DNS:9441/api/calling` |
| Enable Streaming Endpoint | Cocher |

Exemple : `https://bot.example.com:9441/api/calling`

#### Activer le Canal Teams

1. Dans Azure Bot, aller dans **Channels**
2. Cliquer **Microsoft Teams**
3. Accepter les conditions d'utilisation
4. Dans **Calling** :
   - Activer **Enable calling**
   - Webhook : `https://VOTRE_DNS:9441/api/calling`
5. Sauvegarder

---

## Configuration du Serveur Windows

### VM Azure

#### Taille recommandée

| Taille | vCPUs | RAM | Notes |
|--------|-------|-----|-------|
| Standard_D2s_v3 | 2 | 8 Go | Minimum pour production |
| Standard_D4s_v3 | 4 | 16 Go | Recommandé |

**Important** : La VM doit avoir au moins 2 cores **physiques**. Les cores hyper-threadés seuls ne suffisent pas.

#### Configuration réseau

- Attribuer une **IP publique statique**
- Configurer un **nom DNS** (ex: `bot.francecentral.cloudapp.azure.com`)
- Ou utiliser votre propre domaine avec un enregistrement A

### Certificat SSL

#### Option A : Let's Encrypt avec win-acme (Recommandé)

1. Télécharger [win-acme](https://www.win-acme.com/)
2. Extraire dans `C:\win-acme\`
3. Ouvrir un port 80 temporairement (pour validation HTTP)
4. Exécuter :

```powershell
cd C:\win-acme
.\wacs.exe --target manual --host bot.example.com --store certificatestore --installation none
```

5. Suivre les instructions interactives

#### Option B : Certificat existant (PFX)

```powershell
# Importer avec le bon CSP (CRITIQUE pour SChannel/TLS)
certutil -f -csp "Microsoft RSA SChannel Cryptographic Provider" -p "MOT_DE_PASSE" -importpfx My "C:\chemin\certificat.pfx"
```

#### Récupérer le Thumbprint

```powershell
# Lister les certificats
Get-ChildItem -Path Cert:\LocalMachine\My | Format-Table Subject, Thumbprint, NotAfter

# Ou avec certutil
certutil -store My
```

Noter le thumbprint pour la variable `AppSettings__CertificateThumbprint`.

#### Vérifier le CSP du certificat (Important !)

```powershell
certutil -store My THUMBPRINT_ICI
```

La ligne "Fournisseur" ou "Provider" doit indiquer :
```
Fournisseur = Microsoft RSA SChannel Cryptographic Provider
```

Si ce n'est pas le cas, réimporter le certificat avec la commande certutil ci-dessus.

### Pare-feu et NSG

#### Ports à ouvrir

| Port | Protocole | Direction | Usage | Variable .env |
|------|-----------|-----------|-------|---------------|
| 443 | TCP | Entrant | Signalisation externe | `BotInstanceExternalPort` |
| 9441 | TCP | Entrant | Notifications bot | `BotInternalPort` |
| 9442 | TCP | Entrant | Appels bot | `BotCallingInternalPort` |
| 8445 | TCP | Entrant | Média interne | `MediaInternalPort` |
| 22210 | TCP/UDP | Entrant | Média externe | `MediaInstanceExternalPort` |
| 49152-65535 | UDP | Entrant | Flux média RTP | Plage dynamique |

#### Pare-feu Windows

```powershell
# Signalisation Bot
New-NetFirewallRule -DisplayName "TeamsBot-443" -Direction Inbound -Protocol TCP -LocalPort 443 -Action Allow
New-NetFirewallRule -DisplayName "TeamsBot-9441" -Direction Inbound -Protocol TCP -LocalPort 9441 -Action Allow
New-NetFirewallRule -DisplayName "TeamsBot-9442" -Direction Inbound -Protocol TCP -LocalPort 9442 -Action Allow

# Média
New-NetFirewallRule -DisplayName "TeamsBot-8445" -Direction Inbound -Protocol TCP -LocalPort 8445 -Action Allow
New-NetFirewallRule -DisplayName "TeamsBot-22210" -Direction Inbound -Protocol TCP -LocalPort 22210 -Action Allow
New-NetFirewallRule -DisplayName "TeamsBot-22210-UDP" -Direction Inbound -Protocol UDP -LocalPort 22210 -Action Allow

# Flux média dynamiques
New-NetFirewallRule -DisplayName "TeamsBot-Media-UDP" -Direction Inbound -Protocol UDP -LocalPort 49152-65535 -Action Allow
```

#### NSG Azure (Network Security Group)

Ajouter ces règles entrantes :

| Priorité | Nom | Port | Protocole | Action |
|----------|-----|------|-----------|--------|
| 100 | Allow-HTTPS-443 | 443 | TCP | Allow |
| 110 | Allow-Bot-9441 | 9441 | TCP | Allow |
| 120 | Allow-BotCalling-9442 | 9442 | TCP | Allow |
| 130 | Allow-Media-8445 | 8445 | TCP | Allow |
| 140 | Allow-MediaExt-22210 | 22210 | Any | Allow |
| 150 | Allow-Media-UDP-Range | 49152-65535 | UDP | Allow |

---

## Configuration de l'Application

### Fichier .env

Copier le template et le configurer :

```bash
cd TeamsMediaBot/src/TeamsMediaBot
cp .env-template .env
```

### Variables de configuration

```env
# === AUTHENTIFICATION AZURE AD ===
# Application (client) ID de l'App Registration
AppSettings__AadAppId=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

# Secret de l'application (créé dans Certificates & secrets)
AppSettings__AadAppSecret=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# === RÉSEAU ET DNS ===
# FQDN public du serveur (doit correspondre au certificat SSL)
AppSettings__ServiceDnsName=bot.example.com

# FQDN pour le trafic média (généralement identique à ServiceDnsName)
AppSettings__MediaDnsName=bot.example.com

# === CERTIFICAT SSL ===
# Thumbprint du certificat (sans espaces, en majuscules)
AppSettings__CertificateThumbprint=XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX

# === PORTS ===
# Port externe pour la signalisation (ce que Teams voit)
AppSettings__BotInstanceExternalPort=443

# Port interne pour les notifications (Kestrel écoute ici)
AppSettings__BotInternalPort=9441

# Port interne pour les appels
AppSettings__BotCallingInternalPort=9442

# Port externe pour le média (ce que Teams voit)
AppSettings__MediaInstanceExternalPort=8445

# Port interne pour le média
AppSettings__MediaInternalPort=8445

# === MODE DE DÉVELOPPEMENT ===
# true = HTTP (pour ngrok en local), false = HTTPS (production)
AppSettings__UseLocalDevSettings=false

# === AZURE SPEECH SERVICE (Optionnel) ===
# Activer pour la transcription via Azure Cognitive Services
AppSettings__UseSpeechService=false
AppSettings__SpeechConfigKey=
AppSettings__SpeechConfigRegion=
AppSettings__BotLanguage=fr-FR

# === MONITORING (Optionnel) ===
AppSettings__ApplicationInsightsInstrumentationKey=
```

### Configuration des ports : avec ou sans Load Balancer

#### Sans Load Balancer (connexion directe)

Les ports internes et externes doivent être **identiques** :

```env
AppSettings__BotInstanceExternalPort=443
AppSettings__BotInternalPort=9441
AppSettings__MediaInstanceExternalPort=8445
AppSettings__MediaInternalPort=8445
```

#### Avec Load Balancer Azure

Les ports peuvent différer (NAT géré par le LB) :

```env
AppSettings__BotInstanceExternalPort=443
AppSettings__BotInternalPort=9441
AppSettings__MediaInstanceExternalPort=22210
AppSettings__MediaInternalPort=8445
```

---

## Lancer les Services

### Démarrage rapide

```powershell
.\start-bot2.ps1
```

### Démarrage manuel

```powershell
cd src/TeamsMediaBot
dotnet run --configuration Release
```

### Mode production (Service Windows)

```powershell
# Compiler le projet
dotnet publish src/TeamsMediaBot -c Release -o C:\Services\TeamsMediaBot

# Installer TeamsMediaBot comme service
sc.exe create TeamsMediaBot binPath="C:\Services\TeamsMediaBot\TeamsMediaBot.exe" start=auto
sc.exe description TeamsMediaBot "Microsoft Teams Media Bot for audio streaming"

# Démarrer le service
sc.exe start TeamsMediaBot
```

### Vérifier que le service fonctionne

```powershell
# Vérifier les ports en écoute
netstat -an | findstr "LISTENING" | findstr "9441 9442 8445"

# Devrait afficher :
# TCP    0.0.0.0:8445    0.0.0.0:0    LISTENING  (TeamsMediaBot - Media)
# TCP    0.0.0.0:9441    0.0.0.0:0    LISTENING  (TeamsMediaBot - Notifications)
# TCP    0.0.0.0:9442    0.0.0.0:0    LISTENING  (TeamsMediaBot - Calling)
```

```bash
# Tester TeamsMediaBot
curl -k https://bot.example.com:9441/health
```

### URLs disponibles

| URL | Service | Description |
|-----|---------|-------------|
| `https://domain:9441/health` | TeamsMediaBot | Health check du bot |
| `https://domain:9441/calls` | TeamsMediaBot | API pour rejoindre/quitter les meetings |

---

## Utilisation de l'API

### Rejoindre une réunion Teams

**Endpoint** : `POST /calls`

```bash
curl -X POST "https://bot.example.com:9441/calls" \
  -H "Content-Type: application/json" \
  -d '{
    "joinUrl": "https://teams.microsoft.com/l/meetup-join/19%3ameeting_xxx%40thread.v2/0?context=%7b%22Tid%22%3a%22xxx%22%2c%22Oid%22%3a%22xxx%22%7d",
    "displayName": "Transcription Bot"
  }'
```

**Important** : Utiliser le lien **COMPLET** de la réunion, pas le lien court `/meet/...`

Pour obtenir le lien complet :
1. Créer ou ouvrir une réunion Teams
2. Copier le lien depuis l'invitation email ou les détails de la réunion
3. Le format doit être : `https://teams.microsoft.com/l/meetup-join/...`

**Réponse** :

```json
{
  "callId": "13004180-432d-4acd-83de-4f77e335aea9",
  "scenarioId": "2ccb5485-2429-47af-b687-148e9ade4d10",
  "threadId": "19:meeting_xxx@thread.v2",
  "port": "443"
}
```

### Terminer un appel

**Endpoint** : `DELETE /calls?threadId={threadId}`

```bash
curl -X DELETE "https://bot.example.com:9441/calls?threadId=19:meeting_xxx@thread.v2"
```

### Vérifier la santé du service

**Endpoint** : `GET /health`

```bash
curl "https://bot.example.com:9441/health"
```

---

## Intégration MQTT avec le Scheduler

Le TeamsMediaBot peut s'intégrer avec le Scheduler central via MQTT pour recevoir automatiquement les commandes de démarrage/arrêt de bots et streamer l'audio vers le Transcriber.

### Architecture

```
┌─────────────────┐     MQTT      ┌─────────────────┐     WebSocket    ┌─────────────────┐
│    Scheduler    │──────────────►│  TeamsMediaBot  │─────────────────►│   Transcriber   │
│                 │◄──────────────│   (Windows)     │                  │                 │
└─────────────────┘   status      └─────────────────┘                  └─────────────────┘
                      startbot           │
                      stopbot            │ Audio PCM
                                         │ 16kHz mono
                                         ▼
                                  ┌─────────────────┐
                                  │  Teams Meeting  │
                                  └─────────────────┘
```

### Configuration MQTT

Ajouter ces variables dans le fichier `.env` :

```env
# === MQTT Configuration ===
# Adresse du broker MQTT
AppSettings__BrokerHost=mqtt.example.com

# Port du broker (1883 = standard, 8883 = TLS)
AppSettings__BrokerPort=8883

# Identifiants de connexion
AppSettings__BrokerUsername=teamsmediabot
AppSettings__BrokerPassword=secret

# Intervalle de keep-alive en secondes
AppSettings__BrokerKeepAlive=60

# Activer TLS/SSL (recommandé pour les connexions distantes)
AppSettings__BrokerUseTls=true

# Autoriser les certificats non approuvés (dev uniquement)
AppSettings__BrokerAllowUntrustedCertificates=false

# Protocole de transport : Tcp (défaut), WebSocket (ws://), SecureWebSocket (wss://)
AppSettings__BrokerProtocol=Tcp

# Chemin WebSocket (utilisé uniquement avec WebSocket ou SecureWebSocket)
AppSettings__BrokerWebSocketPath=/mqtt

# Nom affiché du bot dans les réunions Teams
AppSettings__BotDisplayName=Transcription Bot
```

### Connexion locale (même réseau)

```env
AppSettings__BrokerHost=192.168.1.100
AppSettings__BrokerPort=1883
AppSettings__BrokerUseTls=false
```

### Connexion distante sécurisée (TLS)

```env
AppSettings__BrokerHost=mqtt.example.com
AppSettings__BrokerPort=8883
AppSettings__BrokerUseTls=true
AppSettings__BrokerUsername=teamsmediabot
AppSettings__BrokerPassword=secret
```

### Connexion via WebSocket (traversée de pare-feu)

Utilisez WebSocket lorsque les ports MQTT standard (1883/8883) sont bloqués par un pare-feu. Les ports 80/443 sont généralement autorisés.

```env
# WebSocket non sécurisé (port 9001 typique)
AppSettings__BrokerHost=mqtt.example.com
AppSettings__BrokerPort=9001
AppSettings__BrokerProtocol=WebSocket
AppSettings__BrokerWebSocketPath=/mqtt
```

```env
# WebSocket sécurisé (wss://, port 443 typique)
AppSettings__BrokerHost=mqtt.example.com
AppSettings__BrokerPort=443
AppSettings__BrokerProtocol=SecureWebSocket
AppSettings__BrokerWebSocketPath=/mqtt
AppSettings__BrokerUsername=teamsmediabot
AppSettings__BrokerPassword=secret
```

**Avantages de WebSocket** :
- Traverse les pare-feux d'entreprise (ports 80/443 souvent ouverts)
- Compatible avec les proxies HTTP
- Fonctionne avec les load balancers HTTP (ALB, nginx, HAProxy)
- Meilleur support dans les environnements cloud

### Configuration du broker Mosquitto (côté serveur)

Pour exposer le broker MQTT sur Internet avec TLS :

**1. Générer ou obtenir un certificat SSL**

```bash
# Avec Let's Encrypt (certbot)
certbot certonly --standalone -d mqtt.example.com
```

**2. Configurer Mosquitto**

```conf
# /etc/mosquitto/conf.d/tls.conf

# Port TCP standard
listener 1883
protocol mqtt

# Port TLS
listener 8883
protocol mqtt
cafile /etc/letsencrypt/live/mqtt.example.com/chain.pem
certfile /etc/letsencrypt/live/mqtt.example.com/cert.pem
keyfile /etc/letsencrypt/live/mqtt.example.com/privkey.pem

# Port WebSocket (pour traversée de pare-feu)
listener 9001
protocol websockets

# Port WebSocket sécurisé (wss://)
listener 9443
protocol websockets
cafile /etc/letsencrypt/live/mqtt.example.com/chain.pem
certfile /etc/letsencrypt/live/mqtt.example.com/cert.pem
keyfile /etc/letsencrypt/live/mqtt.example.com/privkey.pem

# Authentification
allow_anonymous false
password_file /etc/mosquitto/passwd
```

**3. Créer un utilisateur**

```bash
mosquitto_passwd -c /etc/mosquitto/passwd teamsmediabot
```

**4. Exposer les ports dans Docker**

```yaml
# compose.yml
broker:
  image: eclipse-mosquitto:2
  ports:
    - "1883:1883"   # TCP standard
    - "8883:8883"   # TCP TLS
    - "9001:9001"   # WebSocket
    - "9443:9443"   # WebSocket TLS
  volumes:
    - ./mosquitto/config:/mosquitto/config
    - /etc/letsencrypt:/etc/letsencrypt:ro
```

### Topics MQTT

Le TeamsMediaBot utilise les topics suivants :

| Topic | Direction | Description |
|-------|-----------|-------------|
| `botservice/out/{uniqueId}/status` | Publish | Status du bot (toutes les 10s) |
| `botservice/in/#` | Subscribe | Commandes générales |
| `botservice-{uniqueId}/in/startbot` | Subscribe | Démarrer un bot |
| `botservice/in/stopbot` | Subscribe | Arrêter un bot |
| `transcriber/out/{sessionId}/{channelId}/partial` | Subscribe | Transcriptions partielles |
| `transcriber/out/{sessionId}/{channelId}/final` | Subscribe | Transcriptions finales |

### Format du message de status

Publié toutes les 10 secondes sur `botservice/out/{uniqueId}/status` :

```json
{
  "uniqueId": "teamsmediabot-a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "online": true,
  "activeBots": 2,
  "capabilities": ["teams"],
  "on": "2025-01-15T10:30:00.000Z"
}
```

### Format de la commande startbot

Envoyé par le Scheduler sur `botservice-{uniqueId}/in/startbot` :

```json
{
  "session": {
    "id": "session-uuid",
    "name": "Réunion hebdomadaire"
  },
  "channel": {
    "id": "channel-uuid",
    "enableLiveTranscripts": true
  },
  "address": "https://teams.microsoft.com/l/meetup-join/...",
  "botType": "teams",
  "enableDisplaySub": true,
  "websocketUrl": "ws://transcriber:8890/transcriber-ws/session-uuid,0"
}
```

### Format de la commande stopbot

Envoyé par le Scheduler sur `botservice/in/stopbot` :

```json
{
  "sessionId": "session-uuid",
  "channelId": "channel-uuid"
}
```

### Flux de streaming audio

1. Le Scheduler envoie `startbot` via MQTT
2. Le TeamsMediaBot :
   - Se connecte au WebSocket du Transcriber
   - Envoie `{"type": "init", "encoding": "pcm", "sampleRate": 16000}`
   - Attend l'ACK `{"type": "ack"}`
   - Rejoint la réunion Teams
   - Streame l'audio PCM (S16LE, 16kHz, mono) vers le WebSocket
3. Le Transcriber publie les transcriptions via MQTT
4. Le Scheduler envoie `stopbot` pour terminer

### Vérifier la connexion MQTT

```powershell
# Dans les logs du bot, vous devriez voir :
# [TeamsMediaBot] Connecting to MQTT broker at mqtt.example.com:8883
# [TeamsMediaBot] TLS/SSL enabled for MQTT connection
# [TeamsMediaBot] Connected to MQTT broker
# [TeamsMediaBot] MQTT Service fully initialized
```

---

## Dépannage

### Erreur : "MediaPlatform needs a system with at least 2 cores"

**Cause** : La VM n'a pas assez de cores physiques.

**Solution** : Redimensionner la VM pour avoir au minimum 2 cores physiques (pas hyper-threadés).

### Erreur : SEC_E_INVALID_TOKEN (SSL/TLS)

**Causes possibles** :
1. `UseLocalDevSettings=true` alors que vous n'utilisez pas ngrok
2. Certificat avec mauvais CSP (Cryptographic Service Provider)

**Solutions** :

```env
# 1. Vérifier que UseLocalDevSettings est à false
AppSettings__UseLocalDevSettings=false
```

```powershell
# 2. Vérifier le CSP du certificat
certutil -store My VOTRE_THUMBPRINT
# Doit afficher : Fournisseur = Microsoft RSA SChannel Cryptographic Provider

# Si ce n'est pas le cas, réimporter :
certutil -delstore My VOTRE_THUMBPRINT
certutil -f -csp "Microsoft RSA SChannel Cryptographic Provider" -p "" -importpfx My "C:\chemin\certificat.pfx"
```

### Erreur : "Could not verify connectivity to the bot's media platform"

**Cause** : Les ports média ne sont pas accessibles depuis l'extérieur.

**Solutions** :
1. Vérifier les règles NSG Azure
2. Vérifier le pare-feu Windows
3. Vérifier que les ports internes/externes correspondent (sans LB)

```env
# Sans Load Balancer, les ports doivent être identiques :
AppSettings__MediaInstanceExternalPort=8445
AppSettings__MediaInternalPort=8445
```

### Erreur : 401 Unauthorized sur /api/calling

**Cause** : Problème d'authentification Azure AD.

**Solutions** :
1. Vérifier que `AadAppId` et `AadAppSecret` sont corrects
2. Vérifier que le secret n'a pas expiré
3. Vérifier que les permissions API sont accordées avec consentement admin

### Le bot rejoint mais pas d'audio

**Causes possibles** :
1. Permission `Calls.AccessMedia.All` non accordée
2. Problème de ports UDP pour le média

**Solutions** :
1. Vérifier les permissions dans Azure Portal
2. Ouvrir la plage UDP 49152-65535 dans le pare-feu et NSG

### Erreur de connexion MQTT

**Cause** : Le bot ne peut pas se connecter au broker MQTT.

**Solutions** :

```powershell
# 1. Vérifier la connectivité réseau
Test-NetConnection -ComputerName mqtt.example.com -Port 8883

# 2. Vérifier les identifiants
# Les logs afficheront : "[TeamsMediaBot] Failed to connect to MQTT broker"
```

```env
# 3. Pour le debug, autoriser temporairement les certificats self-signed
AppSettings__BrokerAllowUntrustedCertificates=true
```

### Le bot ne reçoit pas les commandes startbot

**Causes possibles** :
1. Le Scheduler n'utilise pas le bon `uniqueId`
2. Problème de topic MQTT

**Solutions** :

```powershell
# 1. Vérifier le uniqueId dans les logs du bot au démarrage
# "[TeamsMediaBot] MQTT Service created with uniqueId: teamsmediabot-xxx"

# 2. Le Scheduler doit envoyer sur : botservice-teamsmediabot-xxx/in/startbot
```

### WebSocket vers le Transcriber échoue

**Cause** : Le TeamsMediaBot ne peut pas joindre le Transcriber.

**Solutions** :
1. Vérifier que le Transcriber est accessible depuis le serveur Windows
2. Vérifier que le port 8890 est ouvert
3. Pour les connexions distantes, exposer le Transcriber ou utiliser un tunnel

```bash
# Test depuis le serveur Windows (PowerShell)
Test-NetConnection -ComputerName transcriber.example.com -Port 8890
```

### Logs et débogage

```powershell
# Voir les logs du service Windows
Get-EventLog -LogName Application -Source "Echo Bot Service" -Newest 50

# Ou lancer en mode console pour voir les logs en direct
cd TeamsMediaBot/src/TeamsMediaBot
dotnet run
```

### Logs MQTT spécifiques

Les logs MQTT sont préfixés par `[TeamsMediaBot]` :

```
[TeamsMediaBot] Connecting to MQTT broker at mqtt.example.com:8883
[TeamsMediaBot] TLS/SSL enabled for MQTT connection
[TeamsMediaBot] Connected to MQTT broker
[TeamsMediaBot] Subscribing to command topics
[TeamsMediaBot] MQTT Service fully initialized
[TeamsMediaBot] Published status: activeBots=0, online=True
[TeamsMediaBot] Received startbot command for session xxx, channel yyy
[TeamsMediaBot] Connecting to Transcriber WebSocket: ws://...
[TeamsMediaBot] WebSocket connected, sending init message
[TeamsMediaBot] Received ACK from Transcriber
[TeamsMediaBot] Joined Teams meeting, threadId: 19:meeting_xxx@thread.v2
[TeamsMediaBot] Audio handler wired for bot xxx_yyy
[TeamsMediaBot] Bot started successfully for key xxx_yyy
```

---

## Architecture des Ports

```
Internet                    │              VM Windows
                            │
Teams Service ──────────────┼──► :443 (BotInstanceExternalPort)
       │                    │         │
       │                    │         ▼
       │                    │    Kestrel :9441 (BotInternalPort)
       │                    │    Kestrel :9442 (BotCallingInternalPort)
       │                    │
       │                    │
Teams Media ────────────────┼──► :8445/:22210 (MediaInstanceExternalPort)
                            │         │
                            │         ▼
                            │    Media Platform :8445 (MediaInternalPort)
```

---

## Ressources

- [Documentation Microsoft Graph Communications](https://microsoftgraph.github.io/microsoft-graph-comms-samples/)
- [Register a Calling Bot](https://microsoftgraph.github.io/microsoft-graph-comms-samples/docs/articles/calls/register-calling-bot.html)
- [Azure Bot Service Documentation](https://docs.microsoft.com/azure/bot-service/)
- [win-acme pour certificats Let's Encrypt](https://www.win-acme.com/)
