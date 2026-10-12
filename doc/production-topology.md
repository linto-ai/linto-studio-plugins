# Production topology — Transcriber behind a load balancer

In production, the **Transcriber service is horizontally scaled behind a load balancer** that handles both TCP (RTMP, WS) and **UDP (SRT)** with connection affinity. This document describes the affinity guarantees the LB provides, what the application architecture does *not* assume, and the operational consequences. It is the companion of [streaming-protocols.md](./streaming-protocols.md) — that one explains per-protocol disconnect semantics on a single instance; this one explains what happens across instances.

## What the load balancer guarantees

| Property | Guarantee |
|---|---|
| Affinity *within* a stream | A stream (one TCP connection for RTMP/WS, one SRT flow identified by 4-tuple) is pinned to a single Transcriber instance for its entire duration. Subsequent packets — including UDP/SRT packets that have no transport-level connection — are routed to the same instance. |
| Affinity *across* a reconnect | **None.** On stream interruption (network glitch, client restart, SRT 5 s inactivity tear-down, RTMP/WS TCP FIN/RST), the LB treats the next stream attempt as a new flow and may route it to a **different** Transcriber instance. |
| Authentication | A stream is addressed by the session's **private** id (`session.privateId`, only exposed inside `streamEndpoints`, broadcast with the session list); the public session id is refused. See `streaming-protocols.md`. Reconnects replace the running connection only with the private id. |
| Parallelism | Only one Transcriber serves a given `(sessionId, channelIndex)` at a time. The application makes no provision for two instances driving the same channel concurrently (see "Race window" below). |

The UDP affinity is what makes SRT survive across the LB. Without it, every SRT packet could land on a different instance and the GStreamer pipeline would never assemble. **Do not change LB configuration without preserving this guarantee.**

## What the application architecture assumes (and does not)

The Scheduler does **not** pre-assign a session to a specific Transcriber instance. The flow is reactive:

1. Scheduler publishes the full list of `ready` / `active` sessions on the retained MQTT topic `system/out/sessions/statuses`. The list does **not** carry a `transcriberId` — every Transcriber instance receives the same payload (`Scheduler/components/BrokerClient/index.js`, around the `publishSessions` method). The Scheduler publishes it again on every connection to the broker (`resynchronize`): a restarted broker has lost it. Its own status, retained, is the cue for every Transcriber to announce itself again, since a Transcriber's status is not retained and one published while the Scheduler was disconnected is lost.
2. When a stream arrives, the receiving Transcriber's `StreamingServer` (SRT/RTMP/WS) validates locally that the session exists in the broadcast list. It does **not** check whether this Transcriber instance "owns" the session (`Transcriber/components/StreamingServer/srt/SRTServer.js#validateStream`, and equivalent in `rtmp/RTMPServer.js`, `ws/WebsocketServer.js`).
3. On `session-start`, the Transcriber announces ownership over MQTT, including its own `uniqueId` (a fresh UUID generated at process start: `Transcriber/appContext.js`).
4. The Scheduler persists this binding by writing `channel.transcriberId = <uniqueId>` to the database (`Scheduler/components/BrokerClient/index.js#updateSession`). This is the *only* place where physical ownership is recorded.

The consequence: **any Transcriber instance is structurally able to serve any session**. The instance that wins is whichever one the LB happens to route the first packet to.

## What happens on a stream interruption with multiple Transcribers

When the LB reroutes a reconnect to a different instance:

| Step | What happens | Where |
|---|---|---|
| 1 | Old instance loses the stream (SRT 5 s timeout, or TCP FIN/RST). Local channel is torn down, ASR provider session is flushed and disposed. Its finals are stored by the Scheduler, which keeps the channel's `lastSegmentId` up to date in the database. | Per [streaming-protocols.md](./streaming-protocols.md). |
| 2 | Client reconnects. LB routes the new flow to a different Transcriber instance. | LB. |
| 3 | The new instance's StreamingServer accepts the connection (validates the session is in `system/out/sessions/statuses`, which it is — the session is still `active`). | `Transcriber/components/StreamingServer/*` |
| 4 | The new instance starts a fresh ASR provider session, numbers its segments after the channel's `lastSegmentId` from the statuses snapshot to keep segment-id continuity, and resumes publishing on `transcriber/out/{sessionId}/{channelId}/partial|final`. | `Transcriber/components/StreamingServer/index.js#resolveInitialSegmentId` |
| 5 | Scheduler observes the new `session-start` and updates `channel.transcriberId` in the database to point to the new instance. | `Scheduler/components/BrokerClient/index.js#updateSession` |

Important: nothing in ASR provider state, partial transcriptions in flight, or process memory survives this switch. All the state needed for continuity must already be on MQTT (retained topics like `system/out/sessions/statuses`, which carries each channel's `lastSegmentId`) or the database. **A Transcriber's process memory must be treated as ephemeral.**

Segment ids of a channel must never repeat: Studio merges closed captions by `segmentId`. A new stream starts after the furthest of two lower bounds (`resolveInitialSegmentId`): the channel's `lastSegmentId` in the statuses snapshot, and the cursor of a stream this same instance stopped (`lastSegmentIds`, process memory). On the same instance, a client may reconnect while its previous stream is still being stopped (ASR flush). When that stop starts, the old stream gets a reserve of 10 segment ids from its current one, and its cursor moves past them (`StreamingServer#_stopAsr`, `ASR#reserveSegmentIds`). The new stream starts at once after the reserve. A final the old stream would need past its reserve is dropped, never renumbered onto an id of the new stream. Ids it did not use are given back when no newer stream started meanwhile. Gaps are harmless; duplicates never happen. Across instances there is no such reservation. The snapshot is republished on status changes, not on every caption. A reconnect that lands on another instance before the Scheduler has processed the old stream's deactivation can therefore start from a `lastSegmentId` that misses the old stream's last captions.

### Per-stream ingest keeps the same contract

The per-stream bot ingest (one ASR per participant, negotiated in the WS `init`/`ack` — see [streaming-protocols.md](./streaming-protocols.md)) adds a fair amount of in-memory state on the Transcriber: the tag → participant map, the N sub-ASR, and the audio-clock → meeting-clock map rebuilt from each frame's `meetingTimeMs`. **None of it is exempt from the rule above.** It is all rebuilt from the wire on a reconnect: the bot replays the participant list in the `init` frame of the new socket, re-runs the negotiation and honours the new grant, and every sub-ASR is recreated lazily on the first frame carrying its tag. Segment-id continuity comes from the same two sources as in the mixed path (`resolveInitialSegmentId`). On the same instance, a per-stream stop reserves the same 10 ids for the trailing finals of its sub-ASR, taken off the channel's shared segment-id allocator: a per-stream connection that starts while it is still being stopped shares that allocator past the reserve, and a legacy stream that starts then continues from its cursor.

Recording behaves identically to the legacy path as well. In per-stream mode the archive is written from the bot's **mixed** flow (frame magic `0x02`), by the channel's single recorder ASR, into a raw file of its own like any stream's (`<sessionId>-<channelId>-<uuid>.pcm`), and goes through the same `ASR.saveAudio()`. So a reconnect, onto this instance or another one, simply produces a second raw file for the channel on the shared `AUDIO_STORAGE_PATH` volume, and the existing "output file already exists" branch of `saveAudio()` (transcode → `concatAudioFiles` → unlink → rename) merges it into the channel's single `.wav`/`.mp3` — the same merge that has always covered an SRT reconnect. On one instance the saves of a channel run one at a time, in stream order. Nothing new is required of the topology, and no per-participant audio is ever written to disk.

## Race window: simultaneous claims

If two Transcribers ever receive a stream for the same `(sessionId, channelIndex)` at the same moment — for example, because the LB briefly hesitates on a reconnect, or because a misbehaving sender opens two parallel streams — both will pass local validation and both will emit `session-start`. The Scheduler resolves this via last-write-wins on `channel.transcriberId`. Deactivation messages from the loser are ignored (`Scheduler/components/BrokerClient/index.js#updateSession` guards against stale `transcriberId`s).

Within a *single* instance the same collision is resolved locally instead: the WS server replaces the existing connection for the channel and only the owning socket may tear the channel state down (see "Connection replacement" in [streaming-protocols.md](./streaming-protocols.md)), so the loser's late close cannot wipe the winner's state or publish a spurious `session-stop`.

The window is short (sub-second) and produces at most a few duplicated MQTT partials on the loser before it sees its own deactivation. It is **not currently exercised by the test suite** — see the failover scenario in `tests/integration/scenarios/`.

The same thing can happen on a **single instance**: a client may reconnect while its previous stream is still being stopped (the ASR flush takes up to `ASR_STOP_FLUSH_TIMEOUT_MS` + `ASR_STOP_SETTLE_MS`). For example, a bot reopens its WS to switch diarization mode. The newer stream's activation then goes out before the old stream's deactivation, and both carry the same `transcriberId`, so the Scheduler guard cannot filter them. The Transcriber therefore does not publish a stopped stream's deactivation when a newer stream already holds the channel (`Transcriber/components/StreamingServer/index.js#_stopAsr`). The old stream's finals and end-of-stream marker are still published. Only the latest stream started on a channel reports it inactive.

When several streams of a channel are being stopped at once (a reconnect, then the session ends), each flushes its own ASR at once, and the rest follows stream order:
- each stream's audio is appended to the channel's audio file after the audio of the streams stopped before it (its place is taken when its stop starts);
- its end-of-stream marker and the deactivation come once the earlier streams' stops are over: their last finals, markers and audio files.

So once the latest stream reports the channel inactive, the captions and kept audio of all its streams are stored, within the stop budget below. Session-end drains rely on this. The finals a newer stream produced while an older one was still flushing are published before the older stream's last finals; their segment ids keep the stream order (see the reserve above).

A stop always stops its own stream's ASR. Streams of two servers may feed one channel (e.g. an SRT stream, then a WS stream, on one instance): audio is routed by stream, and only the latest stream's reaches the channel's ASR and kept audio. The older stream's audio is dropped (a throttled warning counts it), and its ASR keeps running until its own stop.

**Stop budget.** A stream's stop reports its channel inactive at most `ASR_STOP_FLUSH_TIMEOUT_MS` + `ASR_STOP_SETTLE_MS` + `ASR_STOP_AUDIO_SAVE_TIMEOUT_MS` after it starts: 3 + 0.3 + 5 = 8.3 s by default, the last term only with `keepAudio`. Immediate reconnects do not add up: waiting for the earlier streams' stops and for its own audio save, queued behind theirs, both count within that budget. An earlier stop or a save still running when the budget is spent is logged, and the channel is reported inactive anyway: that stream's last captions or audio then come after it. The session-end drains wait up to `SESSION_STOP_FLUSH_TIMEOUT_MS` (Scheduler, `PUT /sessions/:id/stop?waitFinal=true`), 10 s by default: the stop budget plus 1.7 s for MQTT delivery and the Scheduler's database writes. Raise it together with any of the three.

## Implications for design and ops

- **State placement.** Any state that must survive a Transcriber switch belongs in MQTT (retained topics) or the database — never solely in a Transcriber's process memory. New features that introduce in-memory state on the Transcriber should add a corresponding MQTT/DB anchor.
- **No "pin a session to an instance" API.** Do not assume the Scheduler can route a session to a specific physical Transcriber. The `transcriberProfileId` on a session/channel selects the *logical configuration* (which ASR provider, which keys), not the *physical instance*. The physical instance is chosen by the LB and can change across reconnects.
- **Capacity planning.** "Least-loaded Transcriber" selection in the Scheduler is best-effort and based on the broadcast load metrics; the LB has the final word on routing. Capacity should be sized so that any single instance can absorb a reasonable transient overshoot.
- **Failure isolation.** Killing a Transcriber instance gracefully drains: in-progress streams on that instance disconnect, their clients reconnect through the LB, the new instance picks them up. This is the expected behaviour during deploys and node maintenance.

## Session-end guarantees and their cross-instance limits

When a session ends, its `sessions/ended` notification waits until every channel is reported inactive (Scheduler drain; Studio's manual stop uses `PUT /sessions/:id/stop?waitFinal=true`, which waits the same way).

When the Scheduler ends a session itself (autoEnd, a bot leaving an empty meeting), it owes the notification durably (`sessions.endedNotice`, see `Scheduler/components/BrokerClient/index.js#publishSessionEnded`):
- `pending` is set in the same UPDATE as `terminated`.
- Right before publishing, the Scheduler claims the notice exclusively: `sending:<claim>`, with a 60 s lease (`endedNoticeLeaseUntil`). Two ends of one session (e.g. two bots of one session leaving, or a recovery) cannot both publish it: one claims it, the other finds it claimed and publishes nothing.
- The marker is cleared once the broker acknowledged the message (`MqttClient#publishConfirmed`). A failed publication (client offline, no acknowledgment) gives the claim back (`pending`), and mqtt.js does not send the message again by itself.
- If the Scheduler crashes mid-drain or mid-publication, or the broker is unreachable, the notice stays owed. The Scheduler finishes it when it reconnects to the broker and on its 60 s tick (`recoverEndedNotices`), taking a crashed publication's claim once its lease has run out. This is at least once: a notice acknowledged but not yet cleared when the Scheduler stopped, or acknowledged after the timeout, is published again.
- Session-API's `PUT /sessions/:id/stop?waitFinal=true` clears the marker in its terminating UPDATE. In Studio, only the storing stop uses `waitFinal=true`: deleting a session or a quick meeting stops it, stores the conversation and deletes it (`stopSessionAndFetch` in studio-api). That caller takes the ending over, and the Scheduler then publishes nothing. Any other stop (API clients, Studio's `PUT .../stop` proxy, the admin route) stores nothing and leaves the marker, so the Scheduler's notification still goes out. The trade-off: an API client that stops with `waitFinal=true` without storing suppresses the notification, and the conversation is not stored.
- A storing stop and the notification can still both store the conversation. This happens when the stop runs after the Scheduler claimed the notice and before studio-api's `sessions/ended` handler deleted the session. That window is the handler's duration (GET the session, store the conversation, DELETE the session), typically seconds, not milliseconds.

A Transcriber reports a channel inactive once the stream's last finals, its end-of-stream marker and, with `keepAudio`, its audio file are stored. Some of these guarantees only hold within one Transcriber instance:

- **Segment ids.** Covered above: a reconnect that lands on another instance before the old stream's deactivation is processed can reuse the old stream's last segment ids.
- **Kept audio.** A channel's audio file (`<session>-<channel>.wav|.mp3` in `AUDIO_STORAGE_PATH`) is appended to by each stream's save. A stream that received no audio appends nothing; a WAV channel whose streams all received none still gets an empty WAV file. A save that cannot tell whether the channel file or the stream's encoded audio holds audio (ffprobe failing) fails: it changes nothing, logs an error and leaves the stream's raw `.pcm` file in place, for the orphan sweep below. The saves of a channel are serialized within a process, not across instances that share the storage. If an old instance's save and a new instance's save of the same channel overlap (a stream reconnected elsewhere that stops within seconds), both read the same file and rename their result over it, and one stream's audio is lost. Temporary file names are unique per save, so the saves do not overwrite each other's work in progress.
- **Late deactivation.** Only a channel's latest stream reports it inactive, per instance. An old instance's deactivation arriving after the new instance's activation is ignored by the Scheduler (it carries the old `transcriberId`). The drain then waits for the new instance's own deactivation, which waits for that instance's finals and audio save only.
- **Orphan files.** A stream's raw `.pcm` file and a save's temporary files left by a crash or a failed save are swept by every Transcriber on a statuses snapshot, at most every 10 minutes (`StreamingServer#sweepOrphanAudio`). A file is swept once its session has been gone from the snapshots for an hour, counted from the first sweep of this instance that found it so. A file's age does not count: a stream paused for hours writes nothing, and its session may have just ended. A Transcriber never sweeps the files it still writes or saves itself; the hour leaves the stops and saves of an ended session on other instances time to complete. A Transcriber restarted meanwhile counts the hour again. The directory is read in batches, yielding to the event loop.
- **External translations.** Translations produced by an external translator (e.g. TranslatorPython) for a channel's last finals reach the Scheduler on their own, after the finals. The drain does not wait for them: one that arrives after the Transcriber's deactivation, or after the session is deleted, is missing from the stored conversation (the Scheduler logs it as dropped when the channel no longer exists). Discrete (ASR-native) translations are published before their final and are covered.

## Testing

The integration test stack (`tests/integration/docker-compose.test.yml`) currently runs a **single Transcriber replica with no LB in front**, so the cross-instance reroute path is not exercised. The companion failover scenario (`tests/integration/scenarios/16-transcriber-failover.sh`) brings up two Transcriber instances on separate host ports and simulates an LB reroute by streaming to instance A, interrupting, then streaming to instance B. It asserts:

- The new instance accepts the stream (no rejection due to "session not mine").
- Captions resume on `transcriber/out/{sessionId}/{channelId}/partial|final`.
- `channel.transcriberId` in the database flips to the new instance's UUID.
- Segment-id continuity is preserved (no duplicate `final` segments overlapping the switch).

If you change any of the architectural assumptions documented above, **update this file and that scenario together**.
