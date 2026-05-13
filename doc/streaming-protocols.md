# Streaming protocols — TCP vs UDP semantics

The Transcriber accepts audio over three streaming protocols. They have **intentionally different** session-lifetime semantics, dictated by their underlying transport. This document explains the asymmetry and its operational consequences, especially for `PUT /sessions/:id/pause` and `/resume`.

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
| Reconnect | sender re-opens an SRT connection → new `session-start` → fresh ASR (segmentId carried via `lastSegmentIds`) | client must explicitly reconnect | publisher must explicitly republish |

UDP cannot deliver a transport-level disconnect signal, so SRT relies on a per-channel inactivity sentinel. TCP delivers FIN/RST natively, so WS and RTMP do not need one — they react to the OS-level close events. RTMP additionally bounds zombie detection to ~60 s through the RTMP-level ping protocol.

## Implications for pause / resume

`PUT /sessions/:id/pause` stops the ASR but does **not** close the upstream stream — the audio buffer is flushed and incoming audio is dropped synchronously while paused. What happens during a long pause depends on whether the **sender** keeps sending:

| Scenario | SRT | WS / RTMP |
|---|---|---|
| Pause + sender keeps streaming silently (or streams silence) | packets keep arriving, `lastPacket` stays fresh, no timeout, ASR resumes on the same provider on `PUT /resume` | TCP socket stays open, ASR stays paused on the same provider, `PUT /resume` is immediate |
| Pause + sender stops streaming (audio source closed) | after **5 s**, `checkTimedOutChannel` tears the channel down → `session-stop` → ASR disposed; `PUT /resume` finds no ASR → next stream open creates a fresh ASR (segmentId carried over via `lastSegmentIds`) | as long as TCP socket is open, ASR stays alive (just paused); `PUT /resume` is immediate |
| Pause + sender drops the connection (FIN, RST, process killed) | same as "sender stops streaming" | TCP close detected by server → channel torn down → ASR disposed; `PUT /resume` finds no ASR → restart cycle |

For RTMP specifically: a publisher that dies without sending FIN is detected at most 60 s later by the NMS ping timeout, then follows the WS path.

## Why we keep the asymmetry

1. **It mirrors the transport.** Forcing a server-side inactivity timeout on TCP duplicates a mechanism the kernel already provides; the only "win" would be cutting idle-but-alive sockets, which would break legitimate clients that hold a connection open across long pauses (the explicit pause use case).
2. **It is operationally useful.** SRT senders are often unmanaged (broadcast cameras, hardware encoders) — when they wander off, we have no other way to free the channel. WS/RTMP clients are usually browser/SDK code with explicit lifecycle.
3. **The pause/resume contract still holds.** Resume is idempotent at the API layer; whether resume hits the same ASR or triggers a fresh start depends on what the sender did during the pause, not on what we promise. Clients should treat pause as "stop transcribing" and not assume a particular ASR identity is preserved.

**Do not "normalize" one protocol against the other** without revisiting these trade-offs. The inline comments in the three server files (`SRTServer.js`, `WebsocketServer.js`, `RTMPServer.js`) point back here so future contributors see the constraint at the relevant call site.
