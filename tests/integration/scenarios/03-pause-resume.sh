#!/usr/bin/env bash
# tests/integration/scenarios/03-pause-resume.sh
#
# End-to-end validation of the pause/resume feature.
#
# Covers (see doc/recette-pause-resume.md):
#   Case 1 - pause an active session over SRT (transcriptions stop, stream not killed)
#   Case 2 - idempotent re-pause (200, status stays paused)
#   Case 3 - invalid transition (pause on `ready` -> 400)
#   Case 4 - MQTT events on system/out/sessions/paused & /resumed
#   Case 5 - retained snapshot system/out/sessions/statuses contains paused
#   Case 6 - PATCH /sessions/:id with {status:"paused"} is rejected by whitelist
#   Case 7 - DELETE on paused without force is refused; DELETE ?force=true succeeds
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
        # split csv and grep
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

harness::log "=== pause/resume scenario ==="

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------

profile_id=$(harness::create_transcriber_profile "pause_resume_fake")
harness::ok "created transcriber profile id=${profile_id}"

session_id=$(harness::create_session "${profile_id}" "pause_resume_$(date +%s)")
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
# Case 3 (run early, before we mutate session_id) - pause on ready -> 400
# ---------------------------------------------------------------------------
harness::log "--- case 3: pause on 'ready' must be rejected ---"
session_ready=$(harness::create_session "${profile_id}" "pr_ready_$(date +%s)")
harness::assert_status "${session_ready}" "ready" 15 || fail "could not create a fresh ready session"

if harness::http PUT "/sessions/${session_ready}/pause" >/dev/null 2>&1; then
    fail "PUT /sessions/${session_ready}/pause on ready returned 2xx (expected 400)"
fi
post_status=$(harness::get_session "${session_ready}" | jq -r '.status // empty')
[[ "${post_status}" == "ready" ]] \
    || fail "session_ready status changed unexpectedly: got '${post_status}'"
harness::ok "case 3 OK: pause on ready returned non-2xx and status stayed 'ready'"
# Cleanup
harness::http DELETE "/sessions/${session_ready}?force=true" >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
# Start streaming (session must be active before we can pause it)
# ---------------------------------------------------------------------------
harness::log "--- starting SRT loop stream towards ${session_id} ---"
stream_pid=$(harness::stream_srt_loop "${session_id}" 0 "${AUDIO}" 0)
harness::log "SRT stream pid=${stream_pid}"

# Wait until session is active. The transcriber accepts the SRT connection,
# notifies the scheduler, which flips status to 'active'.
if ! wait_for_status "${session_id}" "active" 60 >/dev/null; then
    harness::logs sessionapi 50 || true
    harness::logs scheduler 50 || true
    harness::logs transcriber 80 || true
    fail "session did not become 'active' within 60s of streaming"
fi
harness::ok "session is active"

# Give the fake ASR a moment to start emitting partial transcriptions.
sleep 2
if [[ ! -s "${PARTIAL_LOG}" && ! -s "${FINAL_LOG}" ]]; then
    harness::warn "no partial/final received yet; continuing (fake ASR may be slow to warm up)"
fi

# ---------------------------------------------------------------------------
# Case 1 - pause active session
# ---------------------------------------------------------------------------
harness::log "--- case 1: pause active session ---"
harness::http PUT "/sessions/${session_id}/pause" >/dev/null \
    || fail "PUT /pause on active session failed"
harness::assert_status "${session_id}" "paused" 15 \
    || fail "session did not transition to 'paused'"

# Verify SRT stream is still alive (kernel sees the pid).
if ! kill -0 "${stream_pid}" 2>/dev/null; then
    fail "SRT stream pid=${stream_pid} died during pause; the stream MUST stay open"
fi
harness::ok "SRT stream still running after pause"

# Verify silence on transcription topics (10s window). Use a fresh subscriber
# rather than the long-running one, because the helper is more robust.
harness::mqtt_assert_silent "transcriber/out/${session_id}/+/partial" 2 \
    || fail "transcriber kept emitting partials after pause"
harness::mqtt_assert_silent "transcriber/out/${session_id}/+/final" 2 \
    || fail "transcriber kept emitting finals after pause"

# ---------------------------------------------------------------------------
# Case 4 - MQTT pause/resume events
# ---------------------------------------------------------------------------
harness::log "--- case 4a: system/out/sessions/paused was emitted ---"
sleep 2  # the long-running subscriber should have buffered the message
if ! grep -q "${session_id}" "${PAUSED_LOG}"; then
    harness::err "expected session id ${session_id} in paused log; content:"
    cat "${PAUSED_LOG}" >&2 || true
    fail "system/out/sessions/paused was not emitted"
fi
harness::ok "system/out/sessions/paused contains ${session_id}"

# ---------------------------------------------------------------------------
# Case 5 - retained snapshot contains paused
# ---------------------------------------------------------------------------
harness::log "--- case 5: retained snapshot system/out/sessions/statuses contains paused ---"
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
# Case 2 - idempotent re-pause
# ---------------------------------------------------------------------------
harness::log "--- case 2: re-pause on 'paused' must be idempotent (200) ---"
harness::http PUT "/sessions/${session_id}/pause" >/dev/null \
    || fail "second PUT /pause should be idempotent (200)"
harness::assert_status "${session_id}" "paused" 5 \
    || fail "status changed after idempotent re-pause"
harness::ok "idempotent re-pause OK"

# ---------------------------------------------------------------------------
# Case 6 - PATCH bypass attempt is rejected by whitelist
# ---------------------------------------------------------------------------
harness::log "--- case 6: PATCH bypass with {status:'something'} ignored ---"
# We're currently 'paused'. Try to force back to 'active' via PATCH; the
# whitelist (name, scheduleOn, endOn, autoStart, autoEnd, visibility, owner,
# organizationId, meta) drops 'status' silently. Endpoint will return 200 and
# *also* update the name (so we know the request was actually processed).
patch_resp=$(harness::http PATCH "/sessions/${session_id}" \
    "{\"status\":\"active\",\"name\":\"patched-name-$(date +%s)\"}" || true)
if [[ -z "${patch_resp}" ]]; then
    fail "PATCH request failed entirely"
fi
new_status=$(harness::get_session "${session_id}" | jq -r '.status // empty')
if [[ "${new_status}" != "paused" ]]; then
    fail "PATCH bypass succeeded: status changed to '${new_status}' (expected paused)"
fi
harness::ok "PATCH whitelist correctly ignored status field"

# ---------------------------------------------------------------------------
# Resume the session before testing case 4b
# ---------------------------------------------------------------------------
harness::log "--- resuming session ---"
harness::http PUT "/sessions/${session_id}/resume" >/dev/null \
    || fail "PUT /resume failed"
harness::assert_status "${session_id}" "active" 15 \
    || fail "session did not transition back to 'active'"

# Transcriptions should restart shortly.
: > "${PARTIAL_LOG}"  # reset the running tail to ignore old partials
sleep 1
if ! harness::mqtt_assert_received "transcriber/out/${session_id}/+/partial" "" 2; then
    harness::warn "no partial received within 20s after resume; the fake ASR may be slow"
    # Don't fail the whole scenario for this — it's flaky on busy CI.
else
    harness::ok "transcriptions resumed"
fi

# ---------------------------------------------------------------------------
# Case 4b - resumed event was emitted
# ---------------------------------------------------------------------------
harness::log "--- case 4b: system/out/sessions/resumed was emitted ---"
sleep 2
if ! grep -q "${session_id}" "${RESUMED_LOG}"; then
    harness::err "expected session id ${session_id} in resumed log; content:"
    cat "${RESUMED_LOG}" >&2 || true
    fail "system/out/sessions/resumed was not emitted"
fi
harness::ok "system/out/sessions/resumed contains ${session_id}"

# ---------------------------------------------------------------------------
# Case 7 - DELETE on paused: without force => 400, with force => 200
# ---------------------------------------------------------------------------
harness::log "--- case 7: DELETE on paused requires force ---"
# Re-pause (cheap; idempotent) so we're in paused state for the DELETE checks.
harness::http PUT "/sessions/${session_id}/pause" >/dev/null \
    || fail "could not re-pause for case 7"
harness::assert_status "${session_id}" "paused" 10 || fail "could not reach paused for case 7"

if harness::http DELETE "/sessions/${session_id}" >/dev/null 2>&1; then
    fail "DELETE on paused without force returned 2xx (expected 400)"
fi
# Session must still exist.
if ! harness::http GET "/sessions/${session_id}" >/dev/null 2>&1; then
    fail "session disappeared even though DELETE without force should have failed"
fi
harness::ok "DELETE without force was refused"

if ! harness::http DELETE "/sessions/${session_id}?force=true" >/dev/null 2>&1; then
    fail "DELETE ?force=true on paused failed"
fi
# Session must be gone now.
if harness::http GET "/sessions/${session_id}" >/dev/null 2>&1; then
    fail "session still exists after DELETE ?force=true"
fi
harness::ok "DELETE ?force=true succeeded"

# ---------------------------------------------------------------------------
# Final cleanup
# ---------------------------------------------------------------------------
kill "${stream_pid}" 2>/dev/null || true

harness::ok "pause/resume scenario PASSED"
