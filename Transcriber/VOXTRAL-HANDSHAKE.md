# Voxtral realtime — démarrages muets (SRT/RTMP/WS) : analyse et plan de fix

Doc d'implémentation autoportant. Périmètre : le handshake de démarrage entre le Transcriber (connecteur `openai_streaming`/`voxstral`) et le serveur realtime du fork vLLM (`linto-vllm`). Deux dépôts sont concernés ; les phases sont découpées pour être livrables indépendamment.

**Symptôme** : un flux (SRT surtout) se connecte normalement, le transport est sain (paquets acquittés), l'audio est décodé et poussé vers Voxtral, et pourtant l'ASR ne produit rien. Intermittent, corrélé aux démarrages/redémarrages rapides. Finit par passer après quelques tentatives. RTMP nettement plus fiable. Aucun signal exploitable côté client pour détecter ou récupérer.

---

## 1. Preuves (logs prod kube-linto-ai, 2026-07-01, session « Test sans TRAD » 4ac018d2)

Quatre tentatives successives du même flux SRT (opusenc → mpegtsmux → rtpmp2tpay → srtsink), même streamid, profil `voxtral` (endpoint `ws://linto-vllm-voxtral`) :

| # | heure | pod transcriber | worker gst « transcoding » | résultat |
|---|-------|----|----|----|
| 1 | 20:41:08 | 522rc | jamais (coupé à 5,2 s) | rien |
| 2 | 20:41:13 | xg6pn | jamais (coupé à 5,1 s) | rien |
| 3 | 20:41:18 | 522rc | **oui**, à +0,4 s | **muet pendant 45 s malgré l'audio** |
| 4 | 20:42:07 | 9qg4d | oui | partiels en 0,5 s, tout fonctionne |

Côté vLLM Voxtral, deux warnings, exactement aux instants de **fin** des tentatives 1 et 2 (jamais pendant la tentative 4 réussie ; 22 occurrences en 24 h, toutes corrélées à des démarrages sans transcription) :

```
voxtral_realtime.py:309  Realtime model received empty multimodal embeddings
for 1 input tokens. Returning zero embeddings to avoid engine crash.
```

Pendant la fenêtre muette de la tentative 3, l'engine montrait `Running: 0, Waiting: 1, Deferred: 1` avec une génération résiduelle ~12,5 tok/s, KV cache à 1-5 % : **aucune pression mémoire, aucun slot saturé** (`--max-num-seqs 12`).

Faits établis :
- le transport SRT n'est pas en cause (audio reçu, décodé, poussé) ;
- l'échec n'est pas une contention de ressources GPU ;
- les sessions vLLM « mortes-nées » (armées puis coupées sans audio, tentatives 1-2) laissent une trace anormale (zero embeddings) ;
- une tentative saine (3) peut rester muette juste après ces morts-nées, puis une tentative identique (4) marche.

Zone d'incertitude (à lever en Phase 0) : le mécanisme exact qui rend la tentative 3 muette. Deux candidats : (a) l'état résiduel des morts-nées 1-2 côté engine empoisonne la session suivante ; (b) la session 3 se corrompt toute seule au démarrage (course armement/audio, cf. §3). Les fixes proposés couvrent les deux.

---

## 2. Anatomie du démarrage actuel

### 2.1 Chaîne d'ingestion (pourquoi SRT est plus exposé que RTMP)

```
SRT  : srtsink client → SRTServer.js (validation streamid) → fork GstreamerWorker
       → pipeline GStreamer : appsrc ! decodebin ! ... ! appsink   ← typefind, préroll VARIABLE
RTMP : rtmpsink client → RTMPServer → GstreamerWorker
       → rtmpsrc ! flvdemux ! aacparse ! avdec_aac ! ...            ← chaîne explicite, démarrage rapide
```

- SRT (`GstreamerWorker.js:43-54`) : `decodebin` doit détecter le format du flux brut (RTP/MPEG-TS/codec). Le délai jusqu'au premier buffer décodé varie (davantage avec opus qu'avec l'ac3 de la recette de référence). RTMP (`:56-67`) a une chaîne figée, démarrage quasi immédiat.
- SRT est de l'UDP sans FIN : une coupure client n'est détectée que par le timeout d'inactivité de 5 s (`SRTServer.js:31`). Des redémarrages rapides côté client créent donc des chevauchements de cycles de vie côté serveur, et chaque tentative peut tomber sur un des 4 réplicas transcriber (load-balancing UDP), tous branchés sur **le même** backend vLLM.
- Conséquence : en SRT avec restarts rapides, il est facile de créer des connexions ASR **armées puis coupées avant que le premier octet audio ne sorte du pipeline GStreamer** (tentatives 1-2 : jamais atteint « transcoding »).

### 2.2 Connecteur ASR (`Transcriber/ASR/openai_streaming/index.js`)

Séquence au `session-start` :

```
WS open → serveur envoie session.created
  → connecteur envoie session.update {model}                    (index.js:105-106)
  → timer AVEUGLE 500 ms                                        (index.js:113)
      → envoie input_audio_buffer.commit {final:false}          « armement » (index.js:116-117)
      → timer AVEUGLE 200 ms                                    (index.js:120)
          → _sessionReady = true, l'audio commence à partir     (index.js:122-123)
```

Pendant ces ~700 ms (et avant), **tout l'audio reçu est jeté** (`transcribe()`, index.js:530-546 : « WebSocket not ready, dropping audio »).

Le protocole vLLM du connecteur (`protocols/vllm.js:37-55`) ne connaît que `session.created`, `transcription.delta`, `transcription.done`, `error` : **aucun ack** pour `session.update` ni pour le commit. Les timers sont la seule synchronisation. La reconnexion n'existe que sur événement `error`/close de la WS (index.js:239-252) : une session **connectée mais muette** ne déclenche rien, jamais.

### 2.3 Serveur realtime du fork (`linto-vllm`, branche voxtral-realtime-rfc)

`vllm/entrypoints/speech_to_text/realtime/connection.py` :

- Les événements WS sont traités **séquentiellement** (boucle `receive_text` → `await handle_event`, connection.py:67-77). L'ordre update → commit → append est donc garanti par le protocole lui-même : **les timers du connecteur ne servent à rien**.
- `commit {final:false}` → `start_generation()` **immédiatement** (connection.py:160), que le buffer audio soit vide ou non. La requête est enregistrée auprès de l'engine et tire sur `audio_queue`. Sans audio, elle reste `Deferred` dans le scheduler (le premier `StreamingInput` n'est produit qu'une fois `frame_size` d'audio accumulé, voxtral_realtime.py:180-205).
- `feed_audio()` (voxtral_realtime.py:255-267) : à la fin du flux, il pousse le **right padding inconditionnellement**, y compris si `yielded_first_chunk` est resté faux. Une session armée puis déconnectée **sans avoir jamais reçu d'audio** nourrit donc le modèle avec du padding pur au moment du cleanup — c'est le candidat direct pour les warnings « empty multimodal embeddings » observés pile aux instants de déconnexion des tentatives 1-2.
- `cleanup()` (connection.py:286-315) aborte bien la requête engine à la déconnexion (patch anti-zombie récent, présent sur la branche). **À vérifier : l'image qui tourne en prod le contient-elle ?** (cf. Phase 0.)
- Garde `Generation already in progress, ignoring commit` (connection.py:175) : un deuxième commit sur la même WS est ignoré — pas de re-synchronisation possible sur une session déjà partie de travers.

### 2.4 Synthèse des défauts

| # | Défaut | Où | Effet |
|---|---|---|---|
| H1 | Armement sur timers aveugles (500+200 ms), aucun ack protocole | connecteur index.js:109-127 | la génération démarre côté serveur sans corrélation avec la disponibilité de l'audio |
| H2 | Audio jeté tant que `_sessionReady` est faux | connecteur index.js:530-546 | premières syllabes perdues à chaque démarrage ; élargit la fenêtre où la session vLLM tourne sans audio |
| H3 | `commit` sur buffer vide démarre la génération ; right-pad poussé même si la session n'a jamais reçu d'audio | fork connection.py:160, voxtral_realtime.py:255-267 | sessions mortes-nées qui font tourner le modèle sur du vide/padding (zero embeddings), état engine anormal |
| H4 | Aucun watchdog « connecté mais muet » | connecteur (reconnect sur error uniquement, index.js:239-252) | tout échec de handshake = session muette jusqu'à intervention humaine (bounce du flux). Même famille que le bug ASR Microsoft/4429 |
| H5 | (amplificateur) préroll `decodebin` variable en SRT + timeout 5 s UDP + restarts rapides | GstreamerWorker.js:43-54, SRTServer.js:31 | multiplie les occurrences de H1-H3 en SRT ; RTMP y échappe presque toujours |

---

## 3. Plan de fix

### Phase 0 — Vérifications (avant tout code)

**V1. Reproduction locale.** Sur la 4090 locale (install editable du fork, cf. procédure habituelle), avec un petit harnais WS Python/Node :
  - (a) 10 × { connect → session.update → commit → disconnect } sans jamais d'audio, en rafale ;
  - (b) connect → update → commit → premier append 800 ms plus tard (simule le retard typefind) ;
  - (c) deux connexions entrelacées : une morte-née puis immédiatement une saine (reproduit les tentatives 2→3).
  Observer : warnings zero-embeddings, état `Deferred`, et surtout si (c) rend la session saine muette. Ça tranche l'incertitude (a)/(b) du §1.

**V2. Image prod.** Identifier le digest de `linto-vllm-voxtral` en prod et vérifier s'il contient le cleanup-abort (connection.py:286+) et les fixes deferred récents de la branche. Si non, une partie du symptôme peut déjà être due à l'écart image/code : le déploiement de l'image à jour est alors un préalable (décision à part, hors de ce doc).

**V3. Mesure du préroll.** En local, chronométrer appsrc!decodebin jusqu'à PLAYING avec la recette ac3 vs opus (les deux en MPEGTS/RTP). Quantifie H5 et dit si la Phase 3 vaut le coup.

### Phase 1 — Connecteur (linto-studio-plugins, livrable seul, corrige le symptôme)

Fichier principal : `Transcriber/ASR/openai_streaming/index.js`.

**F1. Armement piloté par l'audio, suppression des timers.**
- À `session.created` : envoyer `session.update` immédiatement (inchangé). Pas de timer.
- Nouvel état `_armed = false`. `transcribe(buffer)` ne jette plus l'audio : tant que la session n'est pas armée, il accumule dans un tampon borné (réutiliser `CircularBuffer` de `live-srt-lib`, déjà exposé par les mocks de test ; borne `PRE_COMMIT_BUFFER_MAX_MS`, défaut 10 000 ms d'audio, drop des plus anciens au-delà).
- Au **premier audio disponible** avec WS ouverte et `session.update` envoyé : envoyer `commit {final:false}`, puis flusher le tampon en `input_audio_buffer.append`, puis `_armed = _sessionReady = true`. L'ordre update → commit → append est garanti par la boucle séquentielle du serveur (connection.py:67-77) : aucun délai nécessaire.
- Effets : plus de génération démarrée sans audio (tue H1 côté client et prive H3 de son déclencheur : une connexion coupée avant l'audio n'a **jamais envoyé de commit**, le serveur n'a rien démarré, le cleanup n'a rien à corrompre) ; plus de syllabes perdues (tue H2) ; le retard typefind SRT devient sans conséquence (neutralise H5).
- Écouter l'événement `error` code `model_not_validated` (course théorique résiduelle) : traiter comme erreur de connexion → chemin reconnect existant.

**F2. Watchdog « armé mais muet ».**
- Démarrer un timer `WATCHDOG_NO_RESULT_MS` (défaut 10 000) au premier `append` envoyé ; l'annuler au premier `transcription.delta`/`done` reçu ; le réarmer à chaque silence prolongé n'est PAS nécessaire (le cas visé est le démarrage).
- À expiration : log WARN explicite, fermer la WS, incrémenter `_connGeneration`, relancer `this.start()` après `RECONNECT_DELAY_MS` (mécanique de reconnexion existante). Le tampon F1 conserve les dernières secondes d'audio : pas de trou à la reprise.
- Après `WATCHDOG_MAX_RETRIES` (défaut 3) échecs consécutifs : émettre `ERROR_MAP[5]` (SERVICE_TIMEOUT) vers le broker pour rendre l'échec visible dans Studio, et continuer les tentatives à cadence lente (30 s).
- C'est le filet de sécurité : quel que soit le bug serveur résiduel, le mode de défaillance passe de « muet jusqu'à intervention humaine » à « récupéré en ~12 s ».

**F3. Fermeture propre.** Au `dispose()`, s'assurer que la WS est fermée même quand le `commit {final:true}` échoue (le cleanup serveur — abort engine — est déclenché par la déconnexion). Vérifier l'ordre actuel : commit final → close.

Constantes/ENV nouvelles (mêmes conventions que l'existant : constante en tête de fichier, surchargée par `process.env`) : `PRE_COMMIT_BUFFER_MAX_MS=10000`, `WATCHDOG_NO_RESULT_MS=10000`, `WATCHDOG_MAX_RETRIES=3`.

### Phase 2 — Fork vLLM (linto-vllm, défense en profondeur)

Le connecteur fixé ne protège pas des autres clients (ws_load.py, intégrations tierces) ni d'une régression. Trois durcissements, petits et sûrs :

**G1. Armement paresseux côté serveur.** Dans `handle_event` (connection.py:143-160) : sur `commit {final:false}` avec `audio_queue` vide et aucun audio jamais reçu, mémoriser `self._armed = True` sans appeler `start_generation()`. Dans le handler `append` : si `_armed` et pas de `generation_task` → `start_generation()`. Un commit d'armement précoce (clients existants) devient inoffensif.

**G2. Pas de padding pour les morts-nées.** Dans `feed_audio` (voxtral_realtime.py:255-267) : si `yielded_first_chunk` est resté faux à la fin du flux, `return` direct sans pousser `right_pad`. Le modèle ne voit plus jamais du padding pur.

**G3. Ack protocole (optionnel, compat ascendante).** Émettre `{"type":"input_audio_buffer.committed"}` en réponse au commit (et/ou `session.updated`). Le connecteur actuel ignore les événements inconnus (`parseServerEvent` → null), aucun risque. Permet à terme des clients sans heuristique.

**G4. Observabilité.** WARN avec `connection_id` quand une génération démarre avec queue vide (ne devrait plus arriver après G1) ; compteur métrique « sessions armées jamais nourries » ; l'existant `voxtral_realtime.py:309` gagne le request_id dans le message.

Livraison : commits sur la branche fork habituelle → build Jenkins → image. G1/G2 sont candidats à remonter dans les PR upstream (cohérents avec la PR bugfix existante). Le déploiement prod n'est pas dans ce doc.

### Phase 3 — GStreamer (optionnelle, après mesure V3)

Si V3 montre un préroll opus/decodebin > ~1 s : proposer une chaîne SRT explicite quand le format est connu, ou au minimum documenter la recette client recommandée (ac3 vs opus) dans la doc d'intégration. Après F1, cette phase n'est plus corrective, seulement du confort de latence au premier mot.

---

## 4. Tests et critères d'acceptation

Tests unitaires (infra existante : `Transcriber/tests/`, `helpers/asr_mocks.js` fournit `MockWebSocket` et le `CircularBuffer` réel) :

- **T1** : l'audio reçu avant `session.created` puis avant armement est tamponné, pas jeté ; au premier audio : la séquence émise sur la MockWebSocket est exactement `session.update` → `commit(false)` → `append(s)` avec l'audio tamponné en tête.
- **T2** : aucune trame `commit` émise si aucun audio n'arrive jamais ; la fermeture n'émet pas de commit final orphelin.
- **T3** : tampon borné : au-delà de `PRE_COMMIT_BUFFER_MAX_MS`, les plus anciens chunks sont écartés, taille mémoire stable.
- **T4** : watchdog : append envoyé, aucun delta → reconnexion à `WATCHDOG_NO_RESULT_MS` ; un delta reçu annule le watchdog ; après `WATCHDOG_MAX_RETRIES` échecs → événement SERVICE_TIMEOUT émis.
- **T5** : non-régression des suites existantes (`test_asr_pause_resume`, `test_route_controllers`, segmentation) — le contrat externe de l'ASR (événements partial/final/error) ne change pas.

Validation d'intégration (local d'abord, puis staging — jamais prod) :

- **A1 — le test du collègue** : 20 cycles rapides connect/coupe/reconnect en SRT sur le même streamid (protocole habituel : La-Suite-cut.mp4, opusenc pour coller à son cas), mélange de coupes avant et après le premier audio. Critère : 100 % des connexions ayant émis de l'audio produisent un partial < 5 s après « transcoding » ; 0 warning zero-embeddings côté vLLM sur toute la série.
- **A2 — pas de perte au démarrage** : média commençant par de la parole immédiate → le premier mot figure dans la transcription (aujourd'hui perdu pendant les ~700 ms de timers + drop).
- **A3 — serveur muet simulé** (mock qui accepte tout et ne répond jamais) : récupération automatique en ≤ `WATCHDOG_NO_RESULT_MS + RECONNECT_DELAY_MS`, erreur émise après épuisement des retries.
- **A4 — harnais V1(c) rejoué après G1/G2** : une morte-née suivie d'une session saine → la saine transcrit immédiatement, l'engine ne montre plus ni zero-embeddings ni génération résiduelle.

---

## 5. Hors périmètre / ce qu'on ne touche pas

- Le timeout canal SRT de 5 s (`SRTServer.js:31`) : comportement UDP assumé et documenté, pas la cause.
- La logique de segmentation/drain du connecteur (index.js:435-444) : le choix « pas de commit mid-session » reste valable (interaction connue avec le re-anchor).
- Le déploiement des images (prod) et la session realtime longue durée observée en fond (`rt-ws-dadba1c3`, re-anchor depuis > 1 h) : à investiguer séparément, probablement déjà couverte par le cleanup-abort si l'image prod est à jour (V2 le dira).
- Multi-réplica transcriber et load-balancing UDP : sans impact une fois F1/F2 en place.

## Annexe — références de code

| Quoi | Où |
|---|---|
| Timers d'armement 500/200 ms | `Transcriber/ASR/openai_streaming/index.js:109-127` |
| Drop d'audio pré-ready | `Transcriber/ASR/openai_streaming/index.js:530-546` |
| Reconnexion sur erreur uniquement | `Transcriber/ASR/openai_streaming/index.js:239-252` |
| Protocole vLLM sans ack | `Transcriber/ASR/openai_streaming/protocols/vllm.js:33-55` |
| Pipeline SRT générique (decodebin) vs RTMP explicite | `Transcriber/components/StreamingServer/GstreamerWorker.js:43-67` |
| Timeout canal SRT 5 s | `Transcriber/components/StreamingServer/srt/SRTServer.js:31` |
| commit → start_generation immédiat | fork `vllm/entrypoints/speech_to_text/realtime/connection.py:143-190` |
| Boucle événements séquentielle (ordre garanti) | fork `connection.py:67-77` |
| right-pad inconditionnel dans feed_audio | fork `vllm/model_executor/models/voxtral_realtime.py:255-267` |
| Fallback zero embeddings | fork `voxtral_realtime.py:296-325` (warning :309) |
| Cleanup/abort à la déconnexion (anti-zombie) | fork `connection.py:286-315` |
