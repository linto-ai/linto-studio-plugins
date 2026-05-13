# Acceptance test plan - Session pause/resume

## Prerequisites
- An active session with an assigned transcriber
- A client streaming audio (SRT, RTMP or WebSocket)
- An MQTT client subscribed to the transcription topics

## Scenario 1 - Pausing an active session
**Given** a session in `active` status with audio currently being transcribed
**When** I call `PUT /v1/sessions/:id/pause`
**Then** the response is 200
**And** the session status is `paused`
**And** no further MQTT `transcriber/out/.../partial` or `/final` message is emitted within the next 10 seconds
**And** the incoming audio stream is NOT cut off (the streaming client does not receive an error)
**And** a `system/out/sessions/paused` event is published with `{id, organizationId}`

## Scenario 2 - Resuming a paused session
**Given** a session in `paused` status with audio still incoming
**When** I call `PUT /v1/sessions/:id/resume`
**Then** the response is 200
**And** the session status is `active`
**And** MQTT transcription messages resume within 5 seconds
**And** a `system/out/sessions/resumed` event is published

## Scenario 3 - Pause idempotency
**Given** a session already in `paused` status
**When** I call `PUT /v1/sessions/:id/pause` a second time
**Then** the response is 200
**And** the status stays `paused`
**And** no new `sessions/paused` event is emitted (to be confirmed or not depending on decision)

## Scenario 4 - Invalid transitions
**Given** a session in `ready` status (not yet active)
**When** I call `PUT /v1/sessions/:id/pause`
**Then** the response is 400
**And** the status stays `ready`

(Same for resume on active, on_schedule, terminated)

## Scenario 5 - Stop during pause
**Given** a session in `paused` status
**When** I call `PUT /v1/sessions/:id/stop`
**Then** the response is 200
**And** the status becomes `terminated`
**And** the channels switch to `inactive` streamStatus

## Scenario 6 - Long pause (5 minutes)
**Given** a session in `paused` status for 5 minutes
**And** the client keeps streaming audio without interruption
**When** I inspect the Transcriber memory usage
**Then** it stays stable (no leak)
**And** the GStreamer pipeline does not crash
**And** the SRT/RTMP/WS connection stays open

## Scenario 7 - PATCH bypass forbidden
**Given** a session in `active` status
**When** I call `PATCH /v1/sessions/:id` with body `{"status":"paused"}`
**Then** the status does NOT change (bypass refused by the whitelist)

## Scenario 8 - Protected DELETE
**Given** a session in `paused` status
**When** I call `DELETE /v1/sessions/:id` without the force parameter
**Then** the response is 400
**And** the session still exists
**When** I call `DELETE /v1/sessions/:id?force=true`
**Then** the response is 200 and the session is deleted

## Scenario 9 - Auto-end during pause
**Given** a session in `paused` status with `endOn` past
**And** `autoEnd` enabled
**When** the scheduler runs its automatic cycle (60 seconds)
**Then** the status becomes `terminated`
**And** an explicit warning log is emitted

## Scenario 10 - Transcriber crash during pause
**Given** a session in `paused` status carried by a transcriber
**When** the transcriber crashes and publishes its offline LWT
**Then** the scheduler detects the disconnection
**And** the session switches to `ready` status (documented downgrade)
**And** an explicit warning log is emitted indicating the downgrade

## Scenario 11 - Multi-channels
**Given** a session with 3 active channels
**When** I pause the session
**Then** all 3 ASRs are stopped
**And** all 3 audio streams keep being drained
**When** I resume
**Then** all 3 ASRs restart

## Scenario 12 - Transcriber MQTT reconnect during pause
**Given** a session in `paused` status
**And** the Transcriber disconnecting/reconnecting MQTT
**When** it receives the retained snapshot
**Then** it applies the pause on the session (idempotent)
**And** does not generate transcription for this session

## Execution procedure
- Manual tests with curl + mosquitto_sub:
  ```bash
  # Pause an active test session
  curl -X PUT https://emeeting.example.com/v1/sessions/<SESSION_ID>/pause \
    -H "Authorization: Bearer <TOKEN>"

  # The retained MQTT status must reflect paused
  mosquitto_sub -h <BROKER> -p <PORT> -u <USER> -P <PASS> \
    -t 'system/out/sessions/statuses' -C 1 \
    | jq '.[] | select(.id=="<SESSION_ID>") | .status'

  # Resume
  curl -X PUT https://emeeting.example.com/v1/sessions/<SESSION_ID>/resume \
    -H "Authorization: Bearer <TOKEN>"
  ```
- Automated tests: `make test-integration` (runs the containerized harness)
