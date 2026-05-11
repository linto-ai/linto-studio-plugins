# Plan de déploiement zéro-downtime — Feature pause/resume

## Section 1 — Vue d'ensemble

La feature pause/resume permet de suspendre temporairement une session de transcription active sans la terminer, puis de la reprendre. Pendant la pause, le slot Transcriber reste réservé, l'audio entrant est drainé sans transcription, et le statut MQTT reflète l'état `paused`. Elle introduit une nouvelle valeur d'enum `paused` sur `sessions.status`, une colonne `pausedAt`, deux endpoints REST (`/pause`, `/resume`) et deux topics MQTT (`system/out/sessions/paused`, `system/out/sessions/resumed`).

## Section 2 — Ordre de déploiement obligatoire

1. **Migration DB** en premier.
   - `ALTER TYPE ... ADD VALUE 'paused'` est rétro-compatible : les services existants ne lisent que les valeurs qu'ils connaissent et ne planteront pas si une nouvelle valeur apparaît côté DB.
   - `addColumn pausedAt` (nullable) est également safe : toute lecture existante l'ignore, toute écriture existante laisse `NULL`.
   - Aucun service à redémarrer à cette étape.

2. **Scheduler** ensuite.
   - Déployer le code qui sait préserver `status='paused'` dans `updateSession`, `unregisterTranscriber` et la boucle `autoEnd`, et qui inclut les sessions `paused` dans `publishSessions`.
   - **Justification de l'ordre** : si on déployait Session-API avant Scheduler, l'utilisateur pourrait créer des sessions `paused`, mais le Scheduler (ancienne version) les écraserait au prochain event de channel ou à la prochaine itération de `unregisterTranscriber`.

3. **Transcriber** ensuite.
   - Déployer le code qui sait drainer l'audio (sans l'envoyer à l'ASR) quand la session est `status=paused`, et qui sait reprendre proprement l'ASR au resume.
   - **Justification de l'ordre** : si déployé avant que Session-API n'émette des `paused`, c'est un no-op côté Transcriber — aucun risque.

4. **Session-API** en dernier.
   - Les nouveaux endpoints `PUT /v1/sessions/:id/pause` et `PUT /v1/sessions/:id/resume` deviennent disponibles.
   - C'est seulement à ce moment que l'utilisateur peut déclencher la pause, et tout le reste de la stack est déjà prêt à la traiter.

5. **Frontend** (LinTO Studio, hors de ce repo).
   - À adapter pour afficher le statut `paused` et exposer les boutons pause/resume.
   - Hors scope de ce déploiement — peut être fait après dans une fenêtre indépendante.

## Section 3 — Rollback

### Rollback du code (Session-API / Scheduler / Transcriber)

Rollback Docker image classique : redéployer le tag précédent. L'ordre inverse est conseillé (Session-API d'abord pour couper les nouveaux pause, puis Transcriber, puis Scheduler).

### Rollback de la migration DB

`ALTER TYPE ... ADD VALUE` **n'est pas réversible** : PostgreSQL ne permet pas `DROP VALUE` sur un enum. Avant tout rollback de la DB, exécuter :

```sql
-- 1. Sortir toutes les sessions de l'état 'paused' avant de retirer l'enum
UPDATE sessions SET status = 'ready' WHERE status = 'paused';

-- 2. Drop de la colonne pausedAt (réversible)
ALTER TABLE sessions DROP COLUMN "pausedAt";
```

La valeur `paused` reste dans la définition de l'enum `enum_sessions_status` même après rollback. Pour la retirer réellement, il faudrait recréer l'enum (`CREATE TYPE ... AS ENUM (...)`, `ALTER TABLE ... ALTER COLUMN ... TYPE`, `DROP TYPE`), opération à éviter en hotfix.

### Rollback de la colonne `pausedAt`

```sql
ALTER TABLE sessions DROP COLUMN "pausedAt";
```

Réversible et sans impact sur les services qui ne la lisent pas.

## Section 4 — Smoke tests post-déploiement

À exécuter manuellement sur l'environnement cible après chaque étape de déploiement (en particulier après Session-API).

```bash
# 1. Pause d'une session active de test
curl -X PUT https://emeeting.example.com/v1/sessions/<SESSION_ID>/pause \
  -H "Authorization: Bearer <TOKEN>"

# 2. Le statut retenu MQTT doit refléter paused
mosquitto_sub -h <BROKER> -p <PORT> -u <USER> -P <PASS> \
  -t 'system/out/sessions/statuses' -C 1 \
  | jq '.[] | select(.id=="<SESSION_ID>") | .status'
# Sortie attendue : "paused"

# 3. Le topic d'événement paused doit recevoir un message
mosquitto_sub -h <BROKER> -p <PORT> -u <USER> -P <PASS> \
  -t 'system/out/sessions/paused' -C 1
# Sortie attendue : payload contenant l'id de session

# 4. Resume
curl -X PUT https://emeeting.example.com/v1/sessions/<SESSION_ID>/resume \
  -H "Authorization: Bearer <TOKEN>"

# 5. Le topic d'événement resumed doit recevoir un message
mosquitto_sub -h <BROKER> -p <PORT> -u <USER> -P <PASS> \
  -t 'system/out/sessions/resumed' -C 1

# 6. Vérifier les logs Transcriber : pause puis resume de l'ASR
docker logs transcriber 2>&1 | grep -i pause
# Sortie attendue : lignes "ASR paused" puis "ASR resumed"
```

Les tests 1-3 valident Session-API + Scheduler + MQTT. Le test 6 valide Transcriber.

## Section 5 — Compatibilité ascendante

### Filtre des sessions publiées

Le filtre côté Scheduler passe de `where: { status: ['active', 'ready'] }` à `where: { status: ['active', 'ready', 'paused'] }`. Conséquences pour les consommateurs externes (notamment `studio-api`) :

- Ils recevront désormais des sessions avec `status='paused'` dans le payload retenu de `system/out/sessions/statuses`.
- Si leur frontend ne sait pas afficher `paused`, ils verront un statut inconnu (probablement non rendu ou rendu en libellé brut), **mais pas de crash** côté backend tant qu'ils ne font pas de switch exhaustif.
- Recommandation : prévenir les équipes downstream avant le déploiement.

### Nouveaux topics MQTT

- `system/out/sessions/paused`
- `system/out/sessions/resumed`

Les consommateurs qui s'abonnent via shared subscriptions (cf. pattern existant `sessions/ended`) peuvent commencer à les consommer dès qu'ils sont prêts. Aucun consommateur existant n'est cassé.

## Section 6 — Risques connus

- **Race condition résiduelle** si un `pause` arrive exactement en concurrence avec un `updateSession` côté Scheduler. Atténuée par la clause `WHERE status NOT IN ('paused', 'terminated')` dans `updateSession`, mais pas formellement éliminée. À surveiller dans les logs lors de la première semaine en prod.
- **Failsafe `MAX_PAUSE_DURATION_MIN` non implémenté** : une session peut rester `paused` indéfiniment et squatter un slot Transcriber. À monitorer via alerte sur `pausedAt < NOW() - N hours` (requête DB ou dashboard sur le snapshot retained `system/out/sessions/statuses`). Implémentation de l'auto-termination à planifier comme suite directe de cette feature.
