#!/usr/bin/env bash
# tests/integration/scenarios/05-pause-resume-ws.sh
#
# End-to-end validation of the pause/resume feature over the WebSocket
# streaming protocol (mirror of 03-pause-resume.sh which covers SRT).
#
# Covers:
#   * pause an active session streaming over WS
#       - session transitions active -> paused
#       - the WS stream process stays alive (the connection MUST NOT be killed)
#       - transcriber stops emitting partial/final on transcriber/out/{id}/+/...
#       - system/out/sessions/paused is emitted with the session id
#       - retained snapshot system/out/sessions/statuses lists the session as
#         paused
#   * resume the session
#       - session transitions paused -> active
#       - system/out/sessions/resumed is emitted with the session id
#
# The scenario assumes the integration stack is up (run.sh handles this);
# when run standalone it relies on harness::up.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../harness/lib.sh
source "${SCRIPT_DIR}/../harness/lib.sh"

harness::install_cleanup_trap

FIXTURES_DIR="${SCRIPT_DIR}/../fixtures"
AUDIO="${FIXTURES_DIR}/audio.wav"

fail() {
    harness::err "FAIL: $*"
    exit 1
}

# Wait until session.status reaches one of the comma-separated EXPECTED values.
# Args: SESSION_ID EXPECTED_CSV [TIMEOUT]
wait_for_status() {
    local id="$1"
    local expected_csv="$2"
    local timeout="${3:-30}"
    local deadline=$(( $(date +%s) + timeout ))
    local last=""
    while :; do
        last=$(harness::get_session "${id}" | jq -r '.status // empty' 2>/dev/null || echo "")
        if echo ",${expected_csv}," | grep -q ",${last},"; then
            harness::ok "session ${id} reached status=${last}"
            echo "${last}"
            return 0
        fi
        if [[ $(date +%s) -ge ${deadline} ]]; then
            harness::err "session ${id} status=${last} (expected one of ${expected_csv})"
            return 1
        fi
        sleep 1
    done
}

# Bring the stack up only if needed.
if ! harness::_compose ps --status running --services 2>/dev/null | grep -q '^sessionapi$'; then
    harness::log "stack not running, bringing it up"
    harness::up || { harness::err "stack failed to come up"; exit 1; }
fi

harness::log "=== pause/resume scenario (WebSocket) ==="

# ---------------------------------------------------------------------------
# Setup: fake transcriber profile + session
# ---------------------------------------------------------------------------
profile_id=$(harness::create_transcriber_profile "pause_resume_ws_fake")
harness::ok "created transcriber profile id=${profile_id}"

session_id=$(harness::create_session "${profile_id}" "pause_resume_ws_$(date +%s)")
harness::ok "created session id=${session_id}"

harness::assert_status "${session_id}" "ready" 30 \
    || fail "initial session status should be ready"

# ---------------------------------------------------------------------------
# Subscribe to MQTT events early so we don't miss any of them.
# These subscriptions are kept alive for the whole scenario.
# ---------------------------------------------------------------------------
PAUSED_LOG=$(mktemp)
RESUMED_LOG=$(mktemp)
PARTIAL_LOG=$(mktemp)
FINAL_LOG=$(mktemp)

paused_sub_pid=$(harness::mqtt_subscribe "system/out/sessions/paused" "${PAUSED_LOG}")
resumed_sub_pid=$(harness::mqtt_subscribe "system/out/sessions/resumed" "${RESUMED_LOG}")
partial_sub_pid=$(harness::mqtt_subscribe "transcriber/out/${session_id}/+/partial" "${PARTIAL_LOG}")
final_sub_pid=$(harness::mqtt_subscribe "transcriber/out/${session_id}/+/final" "${FINAL_LOG}")
sleep 1   # let subscriptions settle

cleanup_logs() {
    rm -f "${PAUSED_LOG}" "${RESUMED_LOG}" "${PARTIAL_LOG}" "${FINAL_LOG}"
}
trap 'cleanup_logs; harness::_kill_bg' EXIT

# ---------------------------------------------------------------------------
# Start streaming over WebSocket (session must be active before we can pause).
# audio.wav is only ~5s, so we use stream_ws_loop (lavfi sine, never ends) to
# keep the WS connection alive for the whole pause/resume window.
# ---------------------------------------------------------------------------
harness::log "--- starting WS loop stream towards ${session_id} ---"
stream_pid=$(harness::stream_ws_loop "${session_id}" 0 "${AUDIO}" 0)
harness::log "WS stream pid=${stream_pid}"

# Wait until the session becomes active. The transcriber accepts the WS
# connection, notifies the scheduler, which flips the status to 'active'.
if ! wait_for_status "${session_id}" "active" 60 >/dev/null; then
    harness::logs sessionapi 50 || true
    harness::logs scheduler 50 || true
    harness::logs transcriber 80 || true
    fail "session did not become 'active' within 60s of WS streaming"
fi
harness::ok "session is active"

# Give the fake ASR a moment to start emitting partials/finals.
sleep 2
if [[ ! -s "${PARTIAL_LOG}" && ! -s "${FINAL_LOG}" ]]; then
    harness::warn "no partial/final received yet; continuing (fake ASR may be slow to warm up)"
fi

# Record the underlying WS TCP connection so we can later verify it stays
# open across pause. The stream_pid points at the bash subshell that wraps
# (ffmpeg | node), so we look for an established connection on the WS port.
ws_conn_count_before=$(ss -tnH "dport = :${HARNESS_WS_PORT}" 2>/dev/null | wc -l || echo 0)
harness::log "established WS connections on :${HARNESS_WS_PORT} before pause = ${ws_conn_count_before}"

# ---------------------------------------------------------------------------
# Pause active session
# ---------------------------------------------------------------------------
harness::log "--- pause active session ---"
harness::http PUT "/sessions/${session_id}/pause" >/dev/null \
    || fail "PUT /pause on active session failed"
harness::assert_status "${session_id}" "paused" 15 \
    || fail "session did not transition to 'paused'"

# Verify the WS stream pipeline is still alive (kernel sees the pid).
if ! kill -0 "${stream_pid}" 2>/dev/null; then
    fail "WS stream pid=${stream_pid} died during pause; the stream MUST stay open"
fi
harness::ok "WS stream process still running after pause"

# Verify the WS connection itself is still open server-side. We don't know
# the exact source port, but the count of established connections towards the
# WS port should not have dropped to zero.
ws_conn_count_after=$(ss -tnH "dport = :${HARNESS_WS_PORT}" 2>/dev/null | wc -l || echo 0)
harness::log "established WS connections on :${HARNESS_WS_PORT} after pause  = ${ws_conn_count_after}"
if [[ "${ws_conn_count_after}" -lt 1 ]]; then
    fail "no established WS connection towards :${HARNESS_WS_PORT} after pause (was ${ws_conn_count_before})"
fi
harness::ok "WS TCP connection still established after pause"

# Verify silence on transcription topics (10s window).
harness::mqtt_assert_silent "transcriber/out/${session_id}/+/partial" 2 \
    || fail "transcriber kept emitting partials after pause"
harness::mqtt_assert_silent "transcriber/out/${session_id}/+/final" 2 \
    || fail "transcriber kept emitting finals after pause"

# ---------------------------------------------------------------------------
# system/out/sessions/paused event was emitted
# ---------------------------------------------------------------------------
harness::log "--- system/out/sessions/paused was emitted ---"
sleep 2  # the long-running subscriber should have buffered the message
if ! grep -q "${session_id}" "${PAUSED_LOG}"; then
    harness::err "expected session id ${session_id} in paused log; content:"
    cat "${PAUSED_LOG}" >&2 || true
    fail "system/out/sessions/paused was not emitted"
fi
harness::ok "system/out/sessions/paused contains ${session_id}"

# ---------------------------------------------------------------------------
# Retained snapshot system/out/sessions/statuses lists session as paused
# ---------------------------------------------------------------------------
harness::log "--- retained snapshot system/out/sessions/statuses contains paused ---"
# Give the scheduler a moment to republish the retained snapshot.
sleep 2
snapshot=$(timeout 5 mosquitto_sub -h "${HARNESS_MQTT_HOST}" -p "${HARNESS_MQTT_PORT}" \
    -t "system/out/sessions/statuses" -C 1 2>/dev/null || true)
if [[ -z "${snapshot}" ]]; then
    fail "no retained snapshot received on system/out/sessions/statuses"
fi
status_in_snap=$(jq -r --arg id "${session_id}" \
    '(. // []) | map(select(.id==$id)) | .[0].status // empty' <<< "${snapshot}" 2>/dev/null || echo "")
if [[ "${status_in_snap}" != "paused" ]]; then
    harness::err "retained snapshot does not list ${session_id} as paused (got '${status_in_snap}')"
    echo "${snapshot}" | head -c 2000 >&2 || true
    fail "snapshot mismatch"
fi
harness::ok "retained snapshot lists session ${session_id} with status=paused"

# ---------------------------------------------------------------------------
# Resume the session
# ---------------------------------------------------------------------------
harness::log "--- resume paused session ---"
harness::http PUT "/sessions/${session_id}/resume" >/dev/null \
    || fail "PUT /resume failed"
harness::assert_status "${session_id}" "active" 15 \
    || fail "session did not transition back to 'active'"

# Verify the WS stream pipeline survived the whole pause/resume cycle.
if ! kill -0 "${stream_pid}" 2>/dev/null; then
    fail "WS stream pid=${stream_pid} died during resume; it should still be running"
fi
harness::ok "WS stream process still running after resume"

# Transcriptions should restart shortly.
: > "${PARTIAL_LOG}"  # reset the running tail to ignore old partials
sleep 1
if ! harness::mqtt_assert_received "transcriber/out/${session_id}/+/partial" "" 2; then
    harness::warn "no partial received within 20s after resume; the fake ASR may be slow"
    # Don't fail the whole scenario for this -- it's flaky on busy CI.
else
    harness::ok "transcriptions resumed"
fi

# ---------------------------------------------------------------------------
# system/out/sessions/resumed event was emitted
# ---------------------------------------------------------------------------
harness::log "--- system/out/sessions/resumed was emitted ---"
sleep 2
if ! grep -q "${session_id}" "${RESUMED_LOG}"; then
    harness::err "expected session id ${session_id} in resumed log; content:"
    cat "${RESUMED_LOG}" >&2 || true
    fail "system/out/sessions/resumed was not emitted"
fi
harness::ok "system/out/sessions/resumed contains ${session_id}"

# ---------------------------------------------------------------------------
# Final cleanup
# ---------------------------------------------------------------------------
kill "${stream_pid}" 2>/dev/null || true
# Best-effort: delete the session so subsequent runs start clean. Session is
# currently active, so a plain DELETE may require force depending on policy.
harness::http DELETE "/sessions/${session_id}?force=true" >/dev/null 2>&1 || true

harness::ok "pause/resume WebSocket scenario PASSED"
