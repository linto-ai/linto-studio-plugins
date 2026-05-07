# Cahier de recette - Pause/Reprise de session

## Préalables
- Une session active avec un transcriber assigné
- Un client streamant de l'audio (SRT, RTMP ou WebSocket)
- Un client MQTT abonné aux topics de transcription

## Scénario 1 - Pause d'une session active
**Étant donné** une session en statut `active` avec audio en cours de transcription
**Quand** j'appelle `PUT /v1/sessions/:id/pause`
**Alors** la réponse est 200
**Et** le statut de la session est `paused`
**Et** plus aucun message MQTT `transcriber/out/.../partial` ou `/final` n'est émis dans les 10 secondes qui suivent
**Et** le flux audio entrant n'est PAS coupé (le client streamer ne reçoit pas d'erreur)
**Et** un événement `system/out/sessions/paused` est publié avec `{id, organizationId}`

## Scénario 2 - Reprise d'une session pausée
**Étant donné** une session en statut `paused` avec audio en cours d'arrivée
**Quand** j'appelle `PUT /v1/sessions/:id/resume`
**Alors** la réponse est 200
**Et** le statut de la session est `active`
**Et** des messages MQTT de transcription reprennent dans les 5 secondes
**Et** un événement `system/out/sessions/resumed` est publié

## Scénario 3 - Idempotence pause
**Étant donné** une session déjà en statut `paused`
**Quand** j'appelle `PUT /v1/sessions/:id/pause` une seconde fois
**Alors** la réponse est 200
**Et** le statut reste `paused`
**Et** aucun nouvel événement `sessions/paused` n'est émis (à confirmer ou pas selon décision)

## Scénario 4 - Transitions invalides
**Étant donné** une session en statut `ready` (pas encore active)
**Quand** j'appelle `PUT /v1/sessions/:id/pause`
**Alors** la réponse est 400
**Et** le statut reste `ready`

(Idem pour resume sur active, on_schedule, terminated)

## Scénario 5 - Stop pendant pause
**Étant donné** une session en statut `paused`
**Quand** j'appelle `PUT /v1/sessions/:id/stop`
**Alors** la réponse est 200
**Et** le statut devient `terminated`
**Et** les channels passent en streamStatus `inactive`

## Scénario 6 - Pause longue (5 minutes)
**Étant donné** une session en statut `paused` depuis 5 minutes
**Et** le client continue à streamer de l'audio sans interruption
**Quand** j'inspecte la consommation mémoire du Transcriber
**Alors** elle reste stable (pas de fuite)
**Et** le pipeline GStreamer ne crash pas
**Et** la connexion SRT/RTMP/WS reste ouverte

## Scénario 7 - PATCH bypass interdit
**Étant donné** une session en statut `active`
**Quand** j'appelle `PATCH /v1/sessions/:id` avec body `{"status":"paused"}`
**Alors** le statut NE change PAS (bypass refusé par la whitelist)

## Scénario 8 - DELETE protégée
**Étant donné** une session en statut `paused`
**Quand** j'appelle `DELETE /v1/sessions/:id` sans paramètre force
**Alors** la réponse est 400
**Et** la session existe toujours
**Quand** j'appelle `DELETE /v1/sessions/:id?force=true`
**Alors** la réponse est 200 et la session est supprimée

## Scénario 9 - Auto-end pendant pause
**Étant donné** une session en statut `paused` avec `endOn` dépassé
**Et** `autoEnd` activé
**Quand** le scheduler exécute son cycle automatique (60 secondes)
**Alors** le statut devient `terminated`
**Et** un log warning explicite est émis

## Scénario 10 - Crash transcriber pendant pause
**Étant donné** une session en statut `paused` portée par un transcriber
**Quand** le transcriber crash et publie son LWT offline
**Alors** le scheduler détecte la déconnexion
**Et** la session passe en statut `ready` (downgrade documenté)
**Et** un log warning explicite est émis indiquant le downgrade

## Scénario 11 - Multi-channels
**Étant donné** une session avec 3 channels actifs
**Quand** je pause la session
**Alors** les 3 ASR sont stoppés
**Et** les 3 streams audio continuent à être drainés
**Quand** je reprends
**Alors** les 3 ASR redémarrent

## Scénario 12 - Reconnect MQTT du Transcriber pendant pause
**Étant donné** une session en statut `paused`
**Et** le Transcriber qui se déconnecte/reconnecte MQTT
**Quand** il reçoit le snapshot retained
**Alors** il applique la pause sur la session (idempotent)
**Et** ne génère pas de transcription pour cette session

## Procédure d'exécution
- Tests manuels avec curl + mosquitto_sub : voir MIGRATION.md section "Smoke tests post-déploiement"
- Tests automatisés : `make test-integration` (lance le harness containerisé)
