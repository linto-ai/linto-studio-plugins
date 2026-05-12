#!/usr/bin/env bash
# tests/integration/scenarios/14-pause-resume-edge-cases.sh
#
# Three edge cases that round out the pause/resume coverage:
#   Case A — resume idempotent: PUT /resume on an already-active session
#            returns 200 and does not emit a stray session-resumed event.
#   Case B — stop during pause: PUT /stop?force=true on a paused session
#            terminates it cleanly.
#   Case C — concurrent pause: two PUT /pause requests fired in parallel
#            on the same active session result in exactly ONE
#            system/out/sessions/paused MQTT message (idempotence at the
#            event-emission layer).
#
# All three cases are covered by unit tests on the Session-API side, but
# this scenario validates the end-to-end behavior through the real broker
# and database.

set -euo pipefail

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

# Bring the stack up only if needed.
if ! harness::_compose ps --status running --services 2>/dev/null | grep -q '^sessionapi$'; then
    harness::log "stack not running, bringing it up"
    harness::up || { harness::err "stack failed to come up"; exit 1; }
fi

harness::log "=== pause/resume edge cases scenario ==="

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------

profile_id=$(harness::create_transcriber_profile "edge_cases_fake")
harness::ok "created transcriber profile id=${profile_id}"

# ---------------------------------------------------------------------------
# Case A — resume idempotent on an already-active session
# ---------------------------------------------------------------------------
harness::log "--- case A: resume idempotent on active session ---"

session_a=$(harness::create_session "${profile_id}" "edge_resume_idem_$(date +%s)")
harness::assert_status "${session_a}" "ready" 15 || fail "case A: session not ready"

# Subscribe to resumed events BEFORE we transition so we observe everything.
RESUMED_LOG_A=$(mktemp)
harness::mqtt_subscribe "system/out/sessions/resumed" "${RESUMED_LOG_A}" >/dev/null
sleep 1   # let subscription settle

# Move to active by streaming.
stream_a=$(harness::stream_srt_loop "${session_a}" 0 "${AUDIO}" 0)
harness::assert_status "${session_a}" "active" 30 \
    || { kill "${stream_a}" 2>/dev/null || true; fail "case A: never reached active"; }

# Now resume on already-active: must return 2xx, status stays active, no event.
if ! harness::put "/sessions/${session_a}/resume" >/dev/null; then
    kill "${stream_a}" 2>/dev/null || true
    fail "case A: PUT /resume on active returned non-2xx (idempotent contract violated)"
fi
post_a=$(harness::get_session "${session_a}" | jq -r '.status // empty')
[[ "${post_a}" == "active" ]] \
    || { kill "${stream_a}" 2>/dev/null || true; fail "case A: status changed unexpectedly to '${post_a}'"; }

# Allow MQTT round-trip then check no resumed event was published.
sleep 2
resumed_count_a=$(grep -c . "${RESUMED_LOG_A}" 2>/dev/null || echo 0)
if [[ "${resumed_count_a}" -gt 0 ]]; then
    kill "${stream_a}" 2>/dev/null || true
    rm -f "${RESUMED_LOG_A}"
    fail "case A: ${resumed_count_a} resumed event(s) published despite no real transition"
fi
rm -f "${RESUMED_LOG_A}"
harness::ok "case A OK: idempotent resume returns 2xx, no stray MQTT event"

# Cleanup case A
kill "${stream_a}" 2>/dev/null || true
sleep 2
harness::http DELETE "/sessions/${session_a}?force=true" >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
# Case B — stop during pause: terminate cleanly
# ---------------------------------------------------------------------------
harness::log "--- case B: stop ?force=true on a paused session ---"

session_b=$(harness::create_session "${profile_id}" "edge_stop_paused_$(date +%s)")
harness::assert_status "${session_b}" "ready" 15 || fail "case B: session not ready"

stream_b=$(harness::stream_srt_loop "${session_b}" 0 "${AUDIO}" 0)
harness::assert_status "${session_b}" "active" 30 \
    || { kill "${stream_b}" 2>/dev/null || true; fail "case B: never reached active"; }

harness::put "/sessions/${session_b}/pause" >/dev/null \
    || { kill "${stream_b}" 2>/dev/null || true; fail "case B: pause failed"; }
harness::assert_status "${session_b}" "paused" 15 \
    || { kill "${stream_b}" 2>/dev/null || true; fail "case B: did not reach paused"; }

# stop without force on paused MUST be refused (regression of the
# Session-API hardening that requires force for both active AND paused).
if harness::http PUT "/sessions/${session_b}/stop" >/dev/null 2>&1; then
    kill "${stream_b}" 2>/dev/null || true
    fail "case B: PUT /stop without force on paused returned 2xx (must be 400)"
fi
harness::ok "case B-1 OK: stop on paused without force is refused"

# stop ?force=true on paused must terminate
if ! harness::put "/sessions/${session_b}/stop?force=true" >/dev/null; then
    kill "${stream_b}" 2>/dev/null || true
    fail "case B: PUT /stop?force=true on paused returned non-2xx"
fi
harness::assert_status "${session_b}" "terminated" 15 \
    || { kill "${stream_b}" 2>/dev/null || true; fail "case B: not terminated after stop ?force=true"; }
harness::ok "case B-2 OK: stop ?force=true on paused terminates the session"

# Cleanup case B
kill "${stream_b}" 2>/dev/null || true
sleep 2
harness::http DELETE "/sessions/${session_b}?force=true" >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
# Case C — concurrent pause: only one MQTT event
# ---------------------------------------------------------------------------
harness::log "--- case C: two parallel PUT /pause emit a single MQTT event ---"

session_c=$(harness::create_session "${profile_id}" "edge_concurrent_pause_$(date +%s)")
harness::assert_status "${session_c}" "ready" 15 || fail "case C: session not ready"

stream_c=$(harness::stream_srt_loop "${session_c}" 0 "${AUDIO}" 0)
harness::assert_status "${session_c}" "active" 30 \
    || { kill "${stream_c}" 2>/dev/null || true; fail "case C: never reached active"; }

# Subscribe BEFORE firing the parallel requests.
PAUSED_LOG_C=$(mktemp)
harness::mqtt_subscribe "system/out/sessions/paused" "${PAUSED_LOG_C}" >/dev/null
sleep 1   # let subscription settle

# Fire two PUT /pause in parallel via background curl.
url="${HARNESS_API_BASE}${HARNESS_API_PREFIX}/sessions/${session_c}/pause"
curl -sS -o /dev/null -X PUT "${url}" &
pid1=$!
curl -sS -o /dev/null -X PUT "${url}" &
pid2=$!
wait "${pid1}" || true
wait "${pid2}" || true

harness::assert_status "${session_c}" "paused" 15 \
    || { kill "${stream_c}" 2>/dev/null || true; rm -f "${PAUSED_LOG_C}"; fail "case C: never reached paused"; }

# Drain the broker for a couple of seconds so any second event can land.
sleep 3
paused_event_count_c=$(grep -c "\"id\":\"${session_c}\"" "${PAUSED_LOG_C}" 2>/dev/null || echo 0)
# The contract is "at most one event for the same session" — the second
# PUT /pause hits the idempotent branch (status already paused) and must
# NOT publish a duplicate.
if [[ "${paused_event_count_c}" -gt 1 ]]; then
    kill "${stream_c}" 2>/dev/null || true
    rm -f "${PAUSED_LOG_C}"
    fail "case C: ${paused_event_count_c} paused events for ${session_c} (expected exactly 1)"
fi
if [[ "${paused_event_count_c}" -lt 1 ]]; then
    kill "${stream_c}" 2>/dev/null || true
    rm -f "${PAUSED_LOG_C}"
    fail "case C: no paused event observed for ${session_c} (expected exactly 1)"
fi
rm -f "${PAUSED_LOG_C}"
harness::ok "case C OK: concurrent pause produced exactly 1 MQTT event"

# Cleanup case C
kill "${stream_c}" 2>/dev/null || true
sleep 2
harness::http DELETE "/sessions/${session_c}?force=true" >/dev/null 2>&1 || true

harness::ok "=== all pause/resume edge cases passed ==="
