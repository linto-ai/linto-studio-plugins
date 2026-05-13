# Production topology — Transcriber behind a load balancer

In production, the **Transcriber service is horizontally scaled behind a load balancer** that handles both TCP (RTMP, WS) and **UDP (SRT)** with connection affinity. This document describes the affinity guarantees the LB provides, what the application architecture does *not* assume, and the operational consequences. It is the companion of [streaming-protocols.md](./streaming-protocols.md) — that one explains per-protocol disconnect semantics on a single instance; this one explains what happens across instances.

## What the load balancer guarantees

| Property | Guarantee |
|---|---|
| Affinity *within* a stream | A stream (one TCP connection for RTMP/WS, one SRT flow identified by 4-tuple) is pinned to a single Transcriber instance for its entire duration. Subsequent packets — including UDP/SRT packets that have no transport-level connection — are routed to the same instance. |
| Affinity *across* a reconnect | **None.** On stream interruption (network glitch, client restart, SRT 5 s inactivity tear-down, RTMP/WS TCP FIN/RST), the LB treats the next stream attempt as a new flow and may route it to a **different** Transcriber instance. |
| Parallelism | Only one Transcriber serves a given `(sessionId, channelIndex)` at a time. The application makes no provision for two instances driving the same channel concurrently (see "Race window" below). |

The UDP affinity is what makes SRT survive across the LB. Without it, every SRT packet could land on a different instance and the GStreamer pipeline would never assemble. **Do not change LB configuration without preserving this guarantee.**

## What the application architecture assumes (and does not)

The Scheduler does **not** pre-assign a session to a specific Transcriber instance. The flow is reactive:

1. Scheduler publishes the full list of `ready` / `active` sessions on the retained MQTT topic `system/out/sessions/statuses`. The list does **not** carry a `transcriberId` — every Transcriber instance receives the same payload (`Scheduler/components/BrokerClient/index.js`, around the `publishSessions` method).
2. When a stream arrives, the receiving Transcriber's `StreamingServer` (SRT/RTMP/WS) validates locally that the session exists in the broadcast list. It does **not** check whether this Transcriber instance "owns" the session (`Transcriber/components/StreamingServer/srt/SRTServer.js#validateStream`, and equivalent in `rtmp/RTMPServer.js`, `ws/WebsocketServer.js`).
3. On `session-start`, the Transcriber announces ownership over MQTT, including its own `uniqueId` (a fresh UUID generated at process start: `Transcriber/appContext.js`).
4. The Scheduler persists this binding by writing `channel.transcriberId = <uniqueId>` to the database (`Scheduler/components/BrokerClient/index.js#updateSession`). This is the *only* place where physical ownership is recorded.

The consequence: **any Transcriber instance is structurally able to serve any session**. The instance that wins is whichever one the LB happens to route the first packet to.

## What happens on a stream interruption with multiple Transcribers

When the LB reroutes a reconnect to a different instance:

| Step | What happens | Where |
|---|---|---|
| 1 | Old instance loses the stream (SRT 5 s timeout, or TCP FIN/RST). Local channel is torn down, ASR provider session is disposed, `lastSegmentIds` is published. | Per [streaming-protocols.md](./streaming-protocols.md). |
| 2 | Client reconnects. LB routes the new flow to a different Transcriber instance. | LB. |
| 3 | The new instance's StreamingServer accepts the connection (validates the session is in `system/out/sessions/statuses`, which it is — the session is still `active`). | `Transcriber/components/StreamingServer/*` |
| 4 | The new instance starts a fresh ASR provider session, picks up the previous `lastSegmentIds` to keep segment-id continuity, and resumes publishing on `transcriber/out/{sessionId}/{channelId}/partial|final`. | Standard SRT-reconnect path. |
| 5 | Scheduler observes the new `session-start` and updates `channel.transcriberId` in the database to point to the new instance. | `Scheduler/components/BrokerClient/index.js#updateSession` |

Important: nothing in ASR provider state, partial transcriptions in flight, or process memory survives this switch. All the state needed for continuity must already be on MQTT (retained topics like `transcriber/out/{sessionId}/{channelId}/lastSegmentIds`) or the database. **A Transcriber's process memory must be treated as ephemeral.**

## Race window: simultaneous claims

If two Transcribers ever receive a stream for the same `(sessionId, channelIndex)` at the same moment — for example, because the LB briefly hesitates on a reconnect, or because a misbehaving sender opens two parallel streams — both will pass local validation and both will emit `session-start`. The Scheduler resolves this via last-write-wins on `channel.transcriberId`. Deactivation messages from the loser are ignored (`Scheduler/components/BrokerClient/index.js#updateSession` guards against stale `transcriberId`s).

The window is short (sub-second) and produces at most a few duplicated MQTT partials on the loser before it sees its own deactivation. It is **not currently exercised by the test suite** — see the failover scenario in `tests/integration/scenarios/`.

## Implications for design and ops

- **State placement.** Any state that must survive a Transcriber switch belongs in MQTT (retained topics) or the database — never solely in a Transcriber's process memory. New features that introduce in-memory state on the Transcriber should add a corresponding MQTT/DB anchor.
- **No "pin a session to an instance" API.** Do not assume the Scheduler can route a session to a specific physical Transcriber. The `transcriberProfileId` on a session/channel selects the *logical configuration* (which ASR provider, which keys), not the *physical instance*. The physical instance is chosen by the LB and can change across reconnects.
- **Capacity planning.** "Least-loaded Transcriber" selection in the Scheduler is best-effort and based on the broadcast load metrics; the LB has the final word on routing. Capacity should be sized so that any single instance can absorb a reasonable transient overshoot.
- **Failure isolation.** Killing a Transcriber instance gracefully drains: in-progress streams on that instance disconnect, their clients reconnect through the LB, the new instance picks them up. This is the expected behaviour during deploys and node maintenance.

## Testing

The integration test stack (`tests/integration/docker-compose.test.yml`) currently runs a **single Transcriber replica with no LB in front**, so the cross-instance reroute path is not exercised. The companion failover scenario (`tests/integration/scenarios/16-transcriber-failover.sh`) brings up two Transcriber instances on separate host ports and simulates an LB reroute by streaming to instance A, interrupting, then streaming to instance B. It asserts:

- The new instance accepts the stream (no rejection due to "session not mine").
- Captions resume on `transcriber/out/{sessionId}/{channelId}/partial|final`.
- `channel.transcriberId` in the database flips to the new instance's UUID.
- `lastSegmentIds` continuity is preserved (no duplicate `final` segments overlapping the switch).

If you change any of the architectural assumptions documented above, **update this file and that scenario together**.
