#!/usr/bin/env bash
# tests/integration/scenarios/10-autoend-during-pause.sh
#
# End-to-end validation of the scheduler's auto-end behavior while a session
# is in the 'paused' state.
#
# Reference: Scheduler/components/BrokerClient/index.js autoEnd()
#   * Every ~60s the scheduler queries sessions where status IN ('ready','paused'),
#     autoEnd=true and endOn < NOW(), then updates them to 'terminated'.
#   * For every paused session being auto-ended, a warn log is emitted:
#       "Auto-ending paused session <id> due to endOn expiry"
#   * Channels of those sessions are flipped to streamStatus='inactive'.
#   * A retained MQTT message is published on `system/out/sessions/ended`
#     with payload {id, organizationId}.
#
# Scenario outline:
#   1. Create a fake-ASR profile and a session with autoEnd=true and
#      endOn = now + 30s (slightly in the future).
#   2. Start an SRT loop stream so the session flips to 'active'.
#   3. Pause it via PUT /sessions/:id/pause -> status must become 'paused'.
#   4. Subscribe to MQTT `system/out/sessions/ended` to catch the event.
#   5. Wait long enough for endOn to elapse AND for the next 60s scheduler
#      tick (90s total: 30s for endOn + up to 60s for the tick).
#      While waiting, periodically check the SRT stream pid is still alive.
#   6. Assert that the session status is 'terminated', that the MQTT
#      `sessions/ended` event was received for that id, and that the warn
#      log was emitted by the scheduler.
#
# The stack must be up before this scenario runs. When invoked standalone,
# it brings the stack up by itself.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../harness/lib.sh
source "${SCRIPT_DIR}/../harness/lib.sh"

harness::install_cleanup_trap

FIXTURES_DIR="${SCRIPT_DIR}/../fixtures"
AUDIO="${FIXTURES_DIR}/audio.wav"

# Tunables
# endOn is set this many seconds in the future at session creation.
TEST_AUTOEND_OFFSET_SEC="${TEST_AUTOEND_OFFSET_SEC:-30}"
# Maximum total wait for the auto-end transition (must cover endOn offset
# plus a full scheduler tick of 60s, plus some slack for transaction commit).
TEST_AUTOEND_TIMEOUT_SEC="${TEST_AUTOEND_TIMEOUT_SEC:-120}"

fail() {
    harness::err "FAIL: $*"
    exit 1
}

# Wait until session.status equals EXPECTED, polling every 2s.
# Args: SESSION_ID EXPECTED_STATUS TIMEOUT_SECONDS
# This is a longer-poll version of harness::assert_status that also
# periodically verifies the SRT stream PID is still alive.
wait_for_terminated_alive_stream() {
    local id="$1"
    local expected="$2"
    local timeout="$3"
    local stream_pid="$4"
    local deadline=$(( $(date +%s) + timeout ))
    local last=""
    while :; do
        last=$(harness::get_session "${id}" | jq -r '.status // empty' 2>/dev/null || echo "")
        if [[ "${last}" == "${expected}" ]]; then
            harness::ok "session ${id} reached status=${expected}"
            return 0
        fi
        # Sanity-check that the producer is still alive throughout the wait;
        # the auto-end path is meaningful only if the stream itself did not die
        # earlier (which would have torn the session down on its own).
        if ! kill -0 "${stream_pid}" 2>/dev/null; then
            harness::warn "SRT stream pid=${stream_pid} died before auto-end fired"
            # Don't bail out: the scheduler may still auto-end the session and
            # the assertion is on the status, not on the stream. We log and
            # continue polling.
        fi
        if [[ $(date +%s) -ge ${deadline} ]]; then
            harness::err "session ${id} status=${last} (expected ${expected}) after ${timeout}s"
            return 1
        fi
        sleep 2
    done
}

# ---------------------------------------------------------------------------
# Bring the stack up only if needed.
# ---------------------------------------------------------------------------
if ! harness::_compose ps --status running --services 2>/dev/null | grep -q '^sessionapi$'; then
    harness::log "stack not running, bringing it up"
    harness::up || { harness::err "stack failed to come up"; exit 1; }
fi

harness::log "=== auto-end during pause scenario ==="

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------
profile_id=$(harness::create_transcriber_profile "autoend_pause_fake")
harness::ok "created transcriber profile id=${profile_id}"

# Compute endOn = now + TEST_AUTOEND_OFFSET_SEC (ISO 8601 with millisecond
# precision, UTC). The scheduler compares against `new Date()` in JS so any
# parseable timestamp works, but we standardize on ISO 8601 for clarity.
endon_iso=$(date -u -d "+${TEST_AUTOEND_OFFSET_SEC} seconds" '+%Y-%m-%dT%H:%M:%S.000Z')
harness::log "creating session with autoEnd=true endOn=${endon_iso}"

session_id=$(harness::create_session_autoend "${profile_id}" "${endon_iso}" "autoend_pause_$(date +%s)")
harness::ok "created session id=${session_id} (autoEnd=true, endOn=${endon_iso})"

# Sanity: the session must be created in 'ready' (no scheduleOn provided).
harness::assert_status "${session_id}" "ready" 15 \
    || fail "initial session status should be 'ready'"

# Confirm the API actually persisted autoEnd/endOn.
session_repr=$(harness::get_session "${session_id}")
autoend_val=$(jq -r '.autoEnd // empty' <<< "${session_repr}")
endon_val=$(jq -r '.endOn // empty' <<< "${session_repr}")
if [[ "${autoend_val}" != "true" ]]; then
    harness::err "session.autoEnd is '${autoend_val}', expected 'true'"
    echo "${session_repr}" >&2
    fail "autoEnd was not persisted"
fi
if [[ -z "${endon_val}" ]]; then
    fail "session.endOn was not persisted"
fi
harness::ok "session persisted with autoEnd=${autoend_val} endOn=${endon_val}"

# ---------------------------------------------------------------------------
# Subscribe to MQTT events early (must capture the retained `ended` event)
# ---------------------------------------------------------------------------
ENDED_LOG=$(mktemp)
ended_sub_pid=$(harness::mqtt_subscribe "system/out/sessions/ended" "${ENDED_LOG}")
sleep 1   # let the subscription settle

cleanup_logs() {
    rm -f "${ENDED_LOG}"
}
trap 'cleanup_logs; harness::_kill_bg' EXIT

# ---------------------------------------------------------------------------
# Start the SRT loop stream and wait for the session to become active.
# ---------------------------------------------------------------------------
harness::log "--- starting SRT loop stream towards ${session_id} ---"
stream_pid=$(harness::stream_srt_loop "${session_id}" 0 "${AUDIO}" 0)
harness::log "SRT stream pid=${stream_pid}"

if ! harness::assert_status "${session_id}" "active" 60; then
    harness::logs sessionapi 50 || true
    harness::logs scheduler  50 || true
    harness::logs transcriber 80 || true
    fail "session did not become 'active' within 60s of streaming"
fi

# ---------------------------------------------------------------------------
# Pause the session.
# ---------------------------------------------------------------------------
harness::log "--- pausing session ${session_id} ---"
harness::http PUT "/sessions/${session_id}/pause" >/dev/null \
    || fail "PUT /sessions/${session_id}/pause failed"
harness::assert_status "${session_id}" "paused" 15 \
    || fail "session did not transition to 'paused'"

# Verify the SRT stream is still alive (pause must not kill it).
if ! kill -0 "${stream_pid}" 2>/dev/null; then
    fail "SRT stream pid=${stream_pid} died right after pause"
fi
harness::ok "SRT stream still running while paused"

# ---------------------------------------------------------------------------
# Wait for the scheduler's auto-end tick to terminate the paused session.
# Worst case: endOn fires (TEST_AUTOEND_OFFSET_SEC) + next scheduler tick (~60s).
# ---------------------------------------------------------------------------
harness::log "--- waiting up to ${TEST_AUTOEND_TIMEOUT_SEC}s for auto-end while paused ---"
if ! wait_for_terminated_alive_stream "${session_id}" "terminated" "${TEST_AUTOEND_TIMEOUT_SEC}" "${stream_pid}"; then
    harness::logs scheduler 100 || true
    fail "session ${session_id} was not auto-terminated while paused"
fi
harness::ok "session ${session_id} was auto-terminated while in 'paused' state"

# ---------------------------------------------------------------------------
# Assert: MQTT `system/out/sessions/ended` event with our session id.
# ---------------------------------------------------------------------------
harness::log "--- checking MQTT system/out/sessions/ended ---"
# Give the broker a moment to deliver any in-flight publish.
sleep 3
if ! grep -q "${session_id}" "${ENDED_LOG}"; then
    harness::err "expected session id ${session_id} in ended log; content:"
    cat "${ENDED_LOG}" >&2 || true
    fail "system/out/sessions/ended was not emitted for ${session_id}"
fi
# Make sure the JSON payload contains an 'id' field matching the session.
# mosquitto_sub -v prints "<topic> <payload>" per line; we drop the topic.
ended_payload=$(awk -v t="system/out/sessions/ended" '$1==t{ $1=""; sub(/^ /,""); print; }' "${ENDED_LOG}" | grep -F "${session_id}" | head -1)
if [[ -z "${ended_payload}" ]]; then
    harness::err "could not isolate payload for ${session_id}; raw log:"
    cat "${ENDED_LOG}" >&2 || true
    fail "payload extraction failed"
fi
ended_id=$(jq -r '.id // empty' <<< "${ended_payload}" 2>/dev/null || echo "")
if [[ "${ended_id}" != "${session_id}" ]]; then
    harness::err "ended payload id='${ended_id}' (expected '${session_id}'); raw: ${ended_payload}"
    fail "ended payload id mismatch"
fi
harness::ok "system/out/sessions/ended received with id=${session_id}"

# ---------------------------------------------------------------------------
# Assert: scheduler emitted the warn log for the paused auto-end.
# ---------------------------------------------------------------------------
harness::log "--- checking scheduler warn log ---"
warn_pattern="Auto-ending paused session ${session_id} due to endOn expiry"
if ! harness::scheduler_log_contains "${warn_pattern}"; then
    harness::err "scheduler logs did not contain expected warn:"
    harness::err "  ${warn_pattern}"
    harness::logs scheduler 200 || true
    fail "expected scheduler warn for paused auto-end not found"
fi
harness::ok "scheduler emitted warn for paused auto-end"

# ---------------------------------------------------------------------------
# Cleanup: kill the producer (the session is already terminated).
# ---------------------------------------------------------------------------
kill "${stream_pid}" 2>/dev/null || true

harness::ok "auto-end during pause scenario PASSED"
