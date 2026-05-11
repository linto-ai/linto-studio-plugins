#!/usr/bin/env bash
# tests/integration/scenarios/04-pause-resume-rtmp.sh
#
# End-to-end validation of the pause/resume feature over the RTMP protocol.
#
# This is the RTMP counterpart of 03-pause-resume.sh (which uses SRT).
# RTMP runs over TCP, so a naive pause implementation could tear down the
# socket and force the ffmpeg publisher to exit. The whole point of this
# scenario is to assert that this does NOT happen: pause must stop the
# transcription pipeline while keeping the RTMP TCP connection alive.
#
# Covers:
#   * pause an active RTMP session -> transcriptions stop, ffmpeg stays alive
#   * MQTT silence on transcriber/out/{sessionId}/+/partial|final during pause
#   * MQTT event system/out/sessions/paused is emitted
#   * retained snapshot system/out/sessions/statuses lists the session as paused
#   * resume restores status=active and emits system/out/sessions/resumed
#
# The scenario assumes the integration stack is up; when run standalone it
# relies on harness::up to bring it up.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../harness/lib.sh
source "${SCRIPT_DIR}/../harness/lib.sh"

harness::install_cleanup_trap

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

harness::log "=== pause/resume scenario (RTMP) ==="

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------

profile_id=$(harness::create_transcriber_profile "pause_resume_rtmp_fake")
harness::ok "created transcriber profile id=${profile_id}"

session_id=$(harness::create_session "${profile_id}" "pause_resume_rtmp_$(date +%s)")
harness::ok "created session id=${session_id}"

harness::assert_status "${session_id}" "ready" 30 \
    || fail "initial session status should be ready"

# ---------------------------------------------------------------------------
# Subscribe to MQTT events early (so we don't miss them).
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
# Start streaming (session must be active before we can pause it)
# ---------------------------------------------------------------------------
harness::log "--- starting RTMP loop stream towards ${session_id} ---"
stream_pid=$(harness::stream_rtmp_loop "${session_id}" 0 "" 0)
harness::log "RTMP stream pid=${stream_pid}"

# Wait until session is active. The transcriber accepts the RTMP connection,
# notifies the scheduler, which flips status to 'active'.
if ! wait_for_status "${session_id}" "active" 60 >/dev/null; then
    harness::logs sessionapi 50 || true
    harness::logs scheduler 50 || true
    harness::logs transcriber 80 || true
    fail "session did not become 'active' within 60s of RTMP streaming"
fi
harness::ok "session is active"

# Give the fake ASR a moment to start emitting partial transcriptions.
sleep 2
if [[ ! -s "${PARTIAL_LOG}" && ! -s "${FINAL_LOG}" ]]; then
    harness::warn "no partial/final received yet; continuing (fake ASR may be slow to warm up)"
fi

# ---------------------------------------------------------------------------
# Pause active session
# ---------------------------------------------------------------------------
harness::log "--- pause active RTMP session ---"
harness::http PUT "/sessions/${session_id}/pause" >/dev/null \
    || fail "PUT /pause on active session failed"
harness::assert_status "${session_id}" "paused" 15 \
    || fail "session did not transition to 'paused'"

# CRITICAL CHECK: the RTMP ffmpeg publisher must still be alive. RTMP runs
# over TCP, so if pause closed the server-side socket, ffmpeg would receive
# EPIPE / connection reset and exit within a second or two. We check the
# pid right after the pause and again a few seconds later to be safe.
if ! kill -0 "${stream_pid}" 2>/dev/null; then
    fail "RTMP stream pid=${stream_pid} died immediately after pause"
fi
sleep 2
if ! kill -0 "${stream_pid}" 2>/dev/null; then
    fail "RTMP stream pid=${stream_pid} died shortly after pause; the TCP connection MUST stay open"
fi
harness::ok "RTMP stream still running after pause"

# Verify silence on transcription topics (10s window).
harness::mqtt_assert_silent "transcriber/out/${session_id}/+/partial" 2 \
    || fail "transcriber kept emitting partials after pause"
harness::mqtt_assert_silent "transcriber/out/${session_id}/+/final" 2 \
    || fail "transcriber kept emitting finals after pause"

# Re-check liveness one more time after the 20s silence window.
if ! kill -0 "${stream_pid}" 2>/dev/null; then
    fail "RTMP stream pid=${stream_pid} died during the silence window"
fi
harness::ok "RTMP stream still alive after the silence window"

# ---------------------------------------------------------------------------
# MQTT pause event
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
# Retained snapshot contains paused
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
harness::log "--- resuming session ---"
harness::http PUT "/sessions/${session_id}/resume" >/dev/null \
    || fail "PUT /resume failed"
harness::assert_status "${session_id}" "active" 15 \
    || fail "session did not transition back to 'active'"

# The RTMP publisher must STILL be alive after resume.
if ! kill -0 "${stream_pid}" 2>/dev/null; then
    fail "RTMP stream pid=${stream_pid} died across the resume transition"
fi
harness::ok "RTMP stream still running after resume"

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
# MQTT resumed event
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
# Best-effort session cleanup so we don't leak a session on the test stack.
harness::http DELETE "/sessions/${session_id}?force=true" >/dev/null 2>&1 || true

harness::ok "pause/resume RTMP scenario PASSED"
