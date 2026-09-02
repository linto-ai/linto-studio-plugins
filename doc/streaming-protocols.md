# Streaming protocols — TCP vs UDP semantics

The Transcriber accepts audio over three streaming protocols. They have **intentionally different** session-lifetime semantics, dictated by their underlying transport. This document explains the asymmetry and its operational consequences, especially for `PUT /sessions/:id/pause` and `/resume`.

> **Production note.** In production, multiple Transcriber instances run behind a UDP-capable load balancer. The semantics described here apply to a single instance — for what happens when a stream reconnects and the LB reroutes it to a different instance, see [production-topology.md](./production-topology.md).

## Endpoints

| Protocol | Transport | Default port | Stream identifier |
|---|---|---|---|
| **SRT** | UDP (connection-oriented overlay) | 8889 | `streamid=sessionId,channelIndex` |
| **RTMP** | TCP (via `node-media-server`) | 1935 | path `/{sessionId}/{channelIndex}` |
| **WebSocket** | TCP | 8890 | URL `ws://host:8890/{sessionId},{channelIndex}` + `init` JSON message |

Pipeline: `Audio Source → [SRT|RTMP|WebSocket] → GStreamer Worker → PCM S16LE 16kHz mono → ASR Provider → MQTT`

## How a session ends per protocol

| Aspect | SRT (UDP) | WS (TCP) | RTMP (TCP) |
|---|---|---|---|
| Disconnect signal from peer | none — packets just stop | TCP FIN/RST → `ws.on('close'/'error')` | TCP FIN/RST → NMS `donePublish` event |
| Server-side inactivity timeout | **5 s** (`channelTimeoutSeconds` in `Transcriber/components/StreamingServer/srt/SRTServer.js`) | **none** — only OS TCP keepalive (hours) | **60 s** (`ping_timeout` in `Transcriber/components/StreamingServer/rtmp/RTMPServer.js`, NMS pings every 30 s) |
| Server-side payload-stall timeout | **15 s** (`payloadTimeoutSeconds`, env `STREAMING_SRT_PAYLOAD_TIMEOUT_SECONDS`) | n/a | n/a |
| Reconnect | sender re-opens an SRT connection → new `session-start` → fresh ASR (segmentId carried via `lastSegmentIds`) | client must explicitly reconnect | publisher must explicitly republish |

UDP cannot deliver a transport-level disconnect signal, so SRT relies on a per-channel inactivity sentinel. TCP delivers FIN/RST natively, so WS and RTMP do not need one — they react to the OS-level close events. RTMP additionally bounds zombie detection to ~60 s through the RTMP-level ping protocol.

SRT needs a second sentinel that the TCP protocols do not: a socket can stay connected and keep waking the read loop while delivering **zero payload** indefinitely (libsrt's TSBPD delivery clock displaced far into the future — see `SRT-WEDGE-RCA.md` in the workspace). Liveness is therefore tracked on two clocks: `lastEvent` (any socket wakeup) drives the 5 s sentinel, `lastPayload` (bytes actually read, via `readChunks`' `onRead` callback) drives the 15 s one. Event-fresh + payload-stale cannot mean "sender gone" — that trips the 5 s predicate first — so it is by construction the wedge signature. Both route to the same teardown, which lets the next caller land on a fresh socket.

### Connection replacement (WS)

TCP gives a disconnect signal, but it gives no ordering guarantee between a **new**
connection for a channel and the **close** of the one it replaces. A client that
reconnects before the old socket's FIN is processed (bot restart, proxy hiccup, a
sender that opens a second stream) makes the Transcriber run
`onConnection` → `needsLocalCleanup` → tear down the old connection, and *then*
receive the old socket's `close` event.

Channel-keyed state is therefore **owner-scoped**: `cleanupWebsocket` only tears
down `runningChannels[channelId]`, the speaker tracker and the per-stream
participant map when the closing socket is the one currently registered as the
owner of that channel (`runningChannels[channelId].ws === this socket`), or when
no connection is registered for it at all (an init that failed before
registration still gets its full teardown). A
**superseded** connection's late close logs a WARN, closes its own socket, kills
its own GStreamer worker and drops its own `runningSessions` entry (matched by
socket identity, not by channel id) — and stops there: it emits no `session-stop`
and deletes none of the successor's state.

This is deliberate, and it applies to the **whole** WS ingest, per-stream and
legacy mixed alike. Without it, the loser's late close wiped the winner's
`runningChannels` / tracker / participant-map entries — leaving a live socket
whose frames found no state at all — and published a `session-stop` that marked
the channel inactive while audio was still flowing. The observable contract is:
one `session-start` per accepted connection, and **one `session-stop` per channel
handover**, emitted by the owner only. A normal (unreplaced) close is unaffected:
it owns its channel, so it takes the full teardown path exactly as before.

SRT and RTMP are untouched — neither multiplexes two sockets onto one channel the
way the WS server does.

## Per-stream ingest (bot WS only)

The WS endpoint carries a second, **opt-in** framing used by the meeting bots (`VisioBotService`, and any client that implements the same contract). A bot may either mix every participant into one PCM flow (the legacy path, used by the Chromium `BotService`) or send **one tagged flow per participant** so the Transcriber can run one ASR per speaker and attribute captions to a real display name instead of an ASR guess.

Everything below is reached **only** through the negotiation; a client that does not ask for it gets the byte-for-byte legacy behaviour.

### Frame format

Binary frames, 8-byte header, little-endian. Byte 0 is a magic that can never collide with a JSON control frame (those start with `0x7B`, `{`):

| Offset | Size | Field | Notes |
|---|---|---|---|
| 0 | u8 | **magic** | `0x01` = per-participant tagged PCM · `0x02` = mixed recording PCM |
| 1 | u8 | tag | participant tag `0..254` for `0x01` (`255` = shared overflow ASR). **Always 0 and ignored** for `0x02` — the mix belongs to no participant |
| 2–3 | u16 | reserved | must be 0; keeps the PCM 16-bit aligned |
| 4–7 | u32 | `meetingTimeMs` | the bot's meeting clock for this frame |
| 8.. | N | PCM | s16le, 16 kHz, mono |

JSON control frames (participant join / leave / rename, `speakerChanged`) travel on the same socket and are recognised by their leading `{`.

### Handshake

Negotiated in both directions, and the bot **always honours the grant, never its own request**:

```jsonc
// bot -> transcriber
{ "type": "init", ..., "perStream": true, "mixedRecording": true }
// transcriber -> bot
{ "type": "ack", "message": "Init done", "perStream": true, "mixedRecording": true }
```

**The ack extension is additive and unconditional.** `perStream` / `mixedRecording` are written on **every** ack `WebsocketServer#handleInitMessage` sends, not only on a bot's — a plain SRT-era WS client that sends `{"type":"init","encoding":"pcm",...}` with neither field now receives `{"type":"ack","message":"Init done","perStream":false,"mixedRecording":false}` instead of `{"type":"ack","message":"Init done"}`. This is a change to a **pre-existing, externally-facing handshake**, so it is deliberately kept to a strictly additive optional extension: nothing was removed or renamed, both new fields default to `false`, and the ack still means exactly "init accepted, start sending audio". Every in-tree consumer only tests `type === 'ack'`; an external client must likewise ignore ack fields it does not know. Emitting them unconditionally (rather than only when the bot asked) is what keeps the grant readable in a log or a capture for **any** connection, and keeps the ack a single shape to parse.

`init.mixedRecording` is a pure **capability advertisement** ("I can also produce a mixed flow"), not a request. The Transcriber decides (`Transcriber/components/StreamingServer/websocket/WebsocketServer.js#handleInitMessage`):

```js
fd.perStream      = perStreamReq && perStreamEnv && (!needsRecording || botCanMix);
fd.mixedRecording = fd.perStream && needsRecording;
```

with `perStreamEnv = TRANSCRIBER_PERSTREAM_DIARIZATION === 'true'` and `needsRecording = channel.keepAudio` (exactly `ASR.init()`'s own gate).

**Fail closed on the archive.** N sub-ASR cannot each own the single per-channel `.pcm`, so per-stream is granted on a channel that must be archived **only** when the bot can supply the `0x02` mixed flow. An older bot that cannot is **demoted to the legacy mixed path** — a correct archive with degraded speaker attribution, never a corrupted one. Both sides log a loud WARN on that demotion; without it the demotion gets diagnosed as "per-stream broke".

| `perStream` requested | `TRANSCRIBER_PERSTREAM_DIARIZATION` | `channel.keepAudio` | bot advertises `mixedRecording` | Granted |
|---|---|---|---|---|
| no | any | any | any | legacy mixed (bit-exact) |
| yes | false | any | any | legacy mixed (bit-exact), ack says `perStream:false` |
| yes | true | false | any | `perStream:true`, `mixedRecording:false` |
| yes | true | true | yes | `perStream:true`, `mixedRecording:true` |
| yes | true | true | **no** | **demoted** to legacy mixed + WARN on both sides |

### Caption timeline

A caption's position on the channel timeline is `astart + start`, where `astart` is the origin of the flow that produced it and `start`/`end` are offsets **from that origin**. Per-stream keeps that contract: each participant has its own sub-ASR, hence its own `astart` and its own offsets. Consumers that place captions on a common timeline rebase them on the channel's earliest `astart` (`Session-API` does exactly that in `DELETE /sessions/:id/delete-captions`), which is why a late joiner lands correctly after the participants already speaking.

`meetingTimeMs` is **not** a second time base. The bot VAD-gates each participant's track, so a sub-ASR only ever receives speech bursts spliced end to end and the provider would report the second burst as if it started right after the first. The Transcriber therefore builds a piecewise audio-clock → meeting-clock map from the per-frame `meetingTimeMs` (`Transcriber/ASR/index.js`, `_noteMeetingTime` / `_applyTimeline`) and **adds the elided silence back** into `start`/`end` at publication time. The origin is untouched, so `astart + start` stays a real instant and every existing timeline consumer keeps working. A `meetingTimeMs` that goes backwards (bot restart, u32 wrap) abandons the map — once, with a WARN — and falls back to identity timestamps.

The mixed `0x02` flow is used **only** to write the channel's `.pcm` archive; it never reaches an ASR.

## Implications for pause / resume

`PUT /sessions/:id/pause` stops the ASR but does **not** close the upstream stream — the audio buffer is flushed and incoming audio is dropped synchronously while paused. What happens during a long pause depends on whether the **sender** keeps sending:

| Scenario | SRT | WS / RTMP |
|---|---|---|
| Pause + sender keeps streaming silently (or streams silence) | packets keep arriving, `lastEvent` and `lastPayload` stay fresh (silence still produces bytes), no timeout, ASR resumes on the same provider on `PUT /resume` | TCP socket stays open, ASR stays paused on the same provider, `PUT /resume` is immediate |
| Pause + sender stops streaming (audio source closed) | after **5 s**, `checkTimedOutChannel` tears the channel down → `session-stop` → ASR disposed; `PUT /resume` finds no ASR → next stream open creates a fresh ASR (segmentId carried over via `lastSegmentIds`) | as long as TCP socket is open, ASR stays alive (just paused); `PUT /resume` is immediate |
| Pause + sender drops the connection (FIN, RST, process killed) | same as "sender stops streaming" | TCP close detected by server → channel torn down → ASR disposed; `PUT /resume` finds no ASR → restart cycle |

For RTMP specifically: a publisher that dies without sending FIN is detected at most 60 s later by the NMS ping timeout, then follows the WS path.

## Why we keep the asymmetry

1. **It mirrors the transport.** Forcing a server-side inactivity timeout on TCP duplicates a mechanism the kernel already provides; the only "win" would be cutting idle-but-alive sockets, which would break legitimate clients that hold a connection open across long pauses (the explicit pause use case).
2. **It is operationally useful.** SRT senders are often unmanaged (broadcast cameras, hardware encoders) — when they wander off, we have no other way to free the channel. WS/RTMP clients are usually browser/SDK code with explicit lifecycle.
3. **The pause/resume contract still holds.** Resume is idempotent at the API layer; whether resume hits the same ASR or triggers a fresh start depends on what the sender did during the pause, not on what we promise. Clients should treat pause as "stop transcribing" and not assume a particular ASR identity is preserved.

**Do not "normalize" one protocol against the other** without revisiting these trade-offs. The inline comments in the three server files (`SRTServer.js`, `WebsocketServer.js`, `RTMPServer.js`) point back here so future contributors see the constraint at the relevant call site.
