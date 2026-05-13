#!/usr/bin/env bash
# tests/integration/scenarios/16-transcriber-failover.sh
#
# Validates the production "load balancer reroutes a reconnect to a different
# Transcriber instance" path. See doc/production-topology.md for context.
#
# In production, multiple Transcriber instances run behind a UDP-capable LB.
# Within a single stream the LB pins to one instance, but **after a stream
# interruption** the reconnect may land on a different instance. The
# application must absorb that: any Transcriber must be able to pick up any
# session that exists in the MQTT-broadcast session list.
#
# This scenario exercises that path locally:
#   1. Bring up a second Transcriber ("transcriber2") on separate host ports.
#   2. Stream SRT to the primary transcriber, wait for session=active, record
#      channel.transcriberId (call it T1).
#   3. Kill the stream and wait > 5s (SRT inactivity timeout) so T1 tears the
#      channel down and disposes its ASR session.
#   4. Start a new SRT stream to transcriber2 on the same (sessionId, channel).
#      This simulates the LB rerouting the reconnect.
#   5. Assert the session goes back to 'active', channel.transcriberId flips
#      to a new uuid (T2), and partial captions resume.
#
# Caveats:
#   * The "race window" (two transcribers receiving a stream for the same
#     session simultaneously) is intentionally NOT exercised here — the 8s
#     sleep guarantees T1 has cleanly let go before T2 picks up. A future
#     scenario can stress that race.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../harness/lib.sh
source "${SCRIPT_DIR}/../harness/lib.sh"
harness::install_cleanup_trap

FIXTURES_DIR="${SCRIPT_DIR}/../fixtures"
AUDIO="${FIXTURES_DIR}/audio.wav"
FAILOVER_COMPOSE="${SCRIPT_DIR}/../docker-compose.failover.yml"

# Host ports for transcriber2 — must match docker-compose.failover.yml.
T2_SRT_PORT=28889

# Default primary transcriber port (re-applied between stream calls in case
# the global was mutated by a previous step).
T1_SRT_PORT=18889

fail() { harness::err "FAIL: $*"; exit 1; }

compose_with_failover() {
    docker compose -p "${HARNESS_PROJECT_NAME}" \
        -f "${HARNESS_COMPOSE_FILE}" \
        -f "${FAILOVER_COMPOSE}" "$@"
}

start_transcriber2() {
    harness::log "starting transcriber2 (failover instance)"
    compose_with_failover up -d --build transcriber2 \
        || fail "could not start transcriber2"

    local deadline=$(( $(date +%s) + 120 ))
    while :; do
        local cid state health
        cid=$(compose_with_failover ps -q transcriber2 2>/dev/null | head -1)
        if [[ -n "${cid}" ]]; then
            state=$(docker inspect -f '{{.State.Status}}' "${cid}" 2>/dev/null || echo missing)
            health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${cid}" 2>/dev/null || echo none)
            case "${state}/${health}" in
                running/healthy|running/none)
                    harness::ok "transcriber2 healthy (${state}/${health})"
                    return 0
                    ;;
            esac
        fi
        if [[ $(date +%s) -ge ${deadline} ]]; then
            compose_with_failover logs --tail=80 transcriber2 || true
            fail "transcriber2 did not become healthy within 120s"
        fi
        sleep 2
    done
}

stop_transcriber2() {
    harness::log "removing transcriber2 (cleanup)"
    compose_with_failover rm -fsv transcriber2 >/dev/null 2>&1 || true
}

# gst-launch in SRT caller mode often ignores SIGTERM when stuck in a
# reconnect loop, so the harness's default kill (SIGTERM via _kill_bg) leaks
# the process when the test exits. The default between_scenarios_cleanup
# pkills gst-launch matching HARNESS_SRT_PORT (18889) — it does NOT cover
# the second transcriber's port (28889). Without an explicit SIGKILL here,
# leaked streamers keep pumping to port 28889 and flood transcriber2 with
# bogus "session not found" connection attempts on subsequent test runs.
kill_failover_streams() {
    pkill -9 -f "gst-launch-1.0.*srtsink.*:${T2_SRT_PORT}" 2>/dev/null || true
    pkill -9 -f "gst-launch-1.0.*srtsink.*:${T1_SRT_PORT}" 2>/dev/null || true
}

# Chain cleanup: SIGKILL leaked SRT streamers → stop transcriber2 → kill
# harness bg pids on exit. Order matters: kill streamers before tearing
# down transcriber2 so the streamers don't briefly retarget the
# now-deleted container while it's exiting.
trap 'kill_failover_streams; stop_transcriber2; harness::_kill_bg' EXIT

# Bring the main stack up only if needed.
if ! harness::_compose ps --status running --services 2>/dev/null | grep -q '^sessionapi$'; then
    harness::log "stack not running, bringing it up"
    harness::up || fail "stack failed to come up"
fi

start_transcriber2

harness::log "=== transcriber failover (LB reroute on reconnect) ==="

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------
profile_id=$(harness::create_transcriber_profile "failover_fake")
harness::ok "profile=${profile_id}"

session_id=$(harness::create_session "${profile_id}" "failover_$(date +%s)")
harness::ok "session=${session_id}"

harness::assert_status "${session_id}" "ready" 30 \
    || fail "initial session status should be 'ready'"

get_transcriber_id() {
    harness::get_session "${session_id}" | jq -r '.channels[0].transcriberId // empty'
}

# Returns 0 if the given service's logs contain a line matching the regex.
# We need this for both transcriber and transcriber2; harness::scheduler_log_contains
# only targets the scheduler.
service_log_contains() {
    local svc="$1"
    local pattern="$2"
    local cid
    cid=$(compose_with_failover ps -q "${svc}" 2>/dev/null | head -1)
    [[ -z "${cid}" ]] && return 1
    docker logs "${cid}" 2>&1 | grep -qE "${pattern}"
}

# ---------------------------------------------------------------------------
# Phase 1 — stream to T1, capture transcriberId
# ---------------------------------------------------------------------------
HARNESS_SRT_PORT="${T1_SRT_PORT}"
stream1_pid=$(harness::stream_srt_loop "${session_id}" 0 "${AUDIO}" 0)
harness::log "stream1 -> T1 (port ${T1_SRT_PORT}) pid=${stream1_pid}"

harness::assert_status "${session_id}" "active" 60 \
    || { harness::logs transcriber 80 || true; fail "session never reached 'active' on T1"; }

# Let the scheduler persist channel.transcriberId after the session-start
# MQTT round-trip.
sleep 3

t1_id=$(get_transcriber_id)
[[ -n "${t1_id}" ]] || fail "channel.transcriberId is empty after T1 activation"
harness::ok "T1 transcriberId = ${t1_id}"

# Sanity check that T1 actually handled the SRT stream (not transcriber2).
# Note: with the FAKE ASR provider we cannot rely on partial captions on
# MQTT (FakeTranscriber.transcribe() is a no-op — it never emits the
# 'transcribing' event that would translate to a `partial` topic), so we
# inspect the transcriber container logs for the per-session session-start
# log line emitted by StreamingServer.
if ! service_log_contains transcriber "Session ${session_id}, channel .* started"; then
    harness::logs transcriber 80 || true
    fail "primary transcriber never logged session-start for ${session_id}"
fi
harness::ok "primary transcriber logged session-start for ${session_id}"

# ---------------------------------------------------------------------------
# Phase 2 — interrupt the stream, wait for T1 to let go
# ---------------------------------------------------------------------------
harness::log "killing stream1 — simulating client disconnect / LB hashing change"
kill "${stream1_pid}" 2>/dev/null || true

# SRT inactivity timeout is 5s (channelTimeoutSeconds in SRTServer.js).
# Wait 8s so T1 has fully:
#   * timed the channel out
#   * emitted session-stop on MQTT
#   * disposed the ASR provider session
# This keeps us out of the "two transcribers claim simultaneously" race.
sleep 8

# ---------------------------------------------------------------------------
# Phase 3 — reconnect to T2 (simulates LB reroute)
# ---------------------------------------------------------------------------
HARNESS_SRT_PORT="${T2_SRT_PORT}"
stream2_pid=$(harness::stream_srt_loop "${session_id}" 0 "${AUDIO}" 0)
harness::log "stream2 -> T2 (port ${T2_SRT_PORT}) pid=${stream2_pid}"

harness::assert_status "${session_id}" "active" 60 \
    || { compose_with_failover logs --tail=80 transcriber2 || true;
         fail "session did not return to 'active' after reroute to T2"; }

# ---------------------------------------------------------------------------
# Phase 4 — assert transcriberId flipped
# ---------------------------------------------------------------------------
deadline=$(( $(date +%s) + 30 ))
t2_id=""
while :; do
    t2_id=$(get_transcriber_id)
    if [[ -n "${t2_id}" && "${t2_id}" != "${t1_id}" ]]; then
        break
    fi
    if [[ $(date +%s) -ge ${deadline} ]]; then
        break
    fi
    sleep 1
done
if [[ -z "${t2_id}" || "${t2_id}" == "${t1_id}" ]]; then
    harness::err "transcriberId did not flip (T1=${t1_id}, current=${t2_id})"
    harness::get_session "${session_id}" | jq '.channels[0]' >&2 || true
    fail "expected channel.transcriberId to change after failover"
fi
harness::ok "transcriberId flipped: ${t1_id} -> ${t2_id}"

# ---------------------------------------------------------------------------
# Phase 5 — assert T2 actually owns the stream now
# ---------------------------------------------------------------------------
# Same caveat as phase 1: with the FAKE provider we have no MQTT partials to
# observe, so we verify that transcriber2 logged a session-start for our
# session id. This is the smoking gun that proves the stream was accepted by
# the second instance and not (silently) by anyone else. The log line is
# emitted from `StreamingServer/index.js:66` when the ASR is created — it
# arrives a couple seconds after session-start propagates through MQTT to
# the scheduler, so poll for up to 15s instead of asserting once.
log_pattern="Session ${session_id}, channel .* started"
deadline=$(( $(date +%s) + 15 ))
saw_log=0
while [[ $(date +%s) -lt ${deadline} ]]; do
    if service_log_contains transcriber2 "${log_pattern}"; then
        saw_log=1
        break
    fi
    sleep 1
done
if [[ ${saw_log} -ne 1 ]]; then
    compose_with_failover logs --tail=80 transcriber2 || true
    fail "transcriber2 never logged session-start for ${session_id}"
fi
harness::ok "transcriber2 logged session-start for ${session_id}"

# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------
kill "${stream2_pid}" 2>/dev/null || true
harness::http DELETE "/sessions/${session_id}?force=true" >/dev/null 2>&1 || true

harness::ok "transcriber failover scenario PASSED"
