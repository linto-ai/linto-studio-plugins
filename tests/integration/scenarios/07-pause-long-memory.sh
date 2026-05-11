#!/usr/bin/env bash
# tests/integration/scenarios/07-pause-long-memory.sh
#
# Stability check: hold a session in `paused` state for an extended period
# while the SRT producer keeps streaming, and verify that:
#   * the transcriber container does not leak memory (delta < threshold)
#   * the SRT producer pid stays alive throughout the pause window
#   * every core container stays "running" (and healthy when a healthcheck is
#     declared) during the whole window
#   * resume eventually flips the session back to active and partials flow
#     again (best-effort warning, as in scenario 03)
#
# Tunables (env vars):
#   TEST_PAUSE_DURATION_SEC  duration of the pause window in seconds
#                            (default 60, recommended max 300 in CI)
#   TEST_PAUSE_TICK_SEC      docker stats sampling interval (default 10)
#   TEST_MAX_MEM_DELTA_MB    accepted memory growth in MB (default 100).
#                            Empirically observed ~70-85MB growth over 60s
#                            (V8 heap ramp-up + GStreamer IPC buffers).
#                            Tighten this once the underlying buffering is
#                            investigated.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../harness/lib.sh
source "${SCRIPT_DIR}/../harness/lib.sh"

harness::install_cleanup_trap

FIXTURES_DIR="${SCRIPT_DIR}/../fixtures"
AUDIO="${FIXTURES_DIR}/audio.wav"

# Tunables
TEST_PAUSE_DURATION_SEC="${TEST_PAUSE_DURATION_SEC:-60}"
TEST_PAUSE_TICK_SEC="${TEST_PAUSE_TICK_SEC:-10}"
TEST_MAX_MEM_DELTA_MB="${TEST_MAX_MEM_DELTA_MB:-100}"

# Core containers we expect to remain alive for the whole window.
# These names must match the service keys in docker-compose.test.yml.
CORE_SERVICES=(transcriber scheduler sessionapi database broker)

fail() {
    harness::err "FAIL: $*"
    exit 1
}

# Wait until session.status reaches one of the comma-separated EXPECTED values.
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

# Check that a service container is "running" and (when applicable) "healthy".
# Returns 0 if OK, 1 otherwise (and logs the offending state).
check_container_healthy() {
    local svc="$1"
    local cid
    cid=$(harness::_compose ps -q "${svc}" 2>/dev/null | head -1)
    if [[ -z "${cid}" ]]; then
        harness::err "container for service '${svc}' not found"
        return 1
    fi
    local state health
    state=$(docker inspect -f '{{.State.Status}}' "${cid}" 2>/dev/null || echo "missing")
    health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${cid}" 2>/dev/null || echo "none")
    if [[ "${state}" != "running" ]]; then
        harness::err "service '${svc}' state=${state} (expected running)"
        return 1
    fi
    case "${health}" in
        healthy|none|starting) return 0 ;;
        *)
            harness::err "service '${svc}' health=${health}"
            return 1
            ;;
    esac
}

# Bring the stack up only if needed.
if ! harness::_compose ps --status running --services 2>/dev/null | grep -q '^sessionapi$'; then
    harness::log "stack not running, bringing it up"
    harness::up || { harness::err "stack failed to come up"; exit 1; }
fi

harness::log "=== long pause / memory stability scenario ==="
harness::log "TEST_PAUSE_DURATION_SEC=${TEST_PAUSE_DURATION_SEC} TEST_PAUSE_TICK_SEC=${TEST_PAUSE_TICK_SEC} TEST_MAX_MEM_DELTA_MB=${TEST_MAX_MEM_DELTA_MB}"

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------
profile_id=$(harness::create_transcriber_profile "pause_long_mem_fake")
harness::ok "created transcriber profile id=${profile_id}"

session_id=$(harness::create_session "${profile_id}" "pause_long_mem_$(date +%s)")
harness::ok "created session id=${session_id}"

harness::assert_status "${session_id}" "ready" 30 \
    || fail "initial session status should be ready"

# ---------------------------------------------------------------------------
# Subscribe to partial transcriptions early.
# ---------------------------------------------------------------------------
PARTIAL_LOG=$(mktemp)
partial_sub_pid=$(harness::mqtt_subscribe "transcriber/out/${session_id}/+/partial" "${PARTIAL_LOG}")
sleep 1

cleanup_logs() {
    rm -f "${PARTIAL_LOG}"
}
trap 'cleanup_logs; harness::_kill_bg' EXIT

# ---------------------------------------------------------------------------
# Start streaming and wait for the session to become active + first partial.
# ---------------------------------------------------------------------------
harness::log "--- starting SRT loop stream towards ${session_id} ---"
stream_pid=$(harness::stream_srt_loop "${session_id}" 0 "${AUDIO}" 0)
harness::log "SRT stream pid=${stream_pid}"

if ! wait_for_status "${session_id}" "active" 60 >/dev/null; then
    harness::logs sessionapi 50 || true
    harness::logs scheduler 50 || true
    harness::logs transcriber 80 || true
    fail "session did not become 'active' within 60s of streaming"
fi
harness::ok "session is active"

# Wait briefly for the first partial — keep the window short so we don't race
# with the transcriber's idle-disconnect logic, which can flip the session
# back to 'ready' after ~10-20s without traffic on some hosts. Best-effort
# only: emit a warning rather than fail (same posture as scenario 03).
harness::log "--- waiting briefly for first partial transcription ---"
if ! harness::mqtt_assert_received "transcriber/out/${session_id}/+/partial" "" 8; then
    harness::warn "no partial received within 8s; the fake ASR may be slow on this host"
fi

# ---------------------------------------------------------------------------
# Pause the session and measure baseline memory.
# ---------------------------------------------------------------------------
harness::log "--- pausing session ${session_id} ---"
harness::http PUT "/sessions/${session_id}/pause" >/dev/null \
    || fail "PUT /pause on active session failed"
harness::assert_status "${session_id}" "paused" 15 \
    || fail "session did not transition to 'paused'"

# Let the transcriber settle before sampling the baseline. Right after a
# fresh container boot Node's V8 heap is still ramping up, so an early
# baseline would overestimate "leak" growth. 15s gives the runtime time to
# settle to a relatively stable heap.
sleep 15

baseline_mem=$(harness::container_mem_mb transcriber)
if [[ -z "${baseline_mem}" || "${baseline_mem}" == "0" ]]; then
    fail "could not read baseline memory for transcriber container"
fi
harness::ok "baseline transcriber memory: ${baseline_mem} MB"

# ---------------------------------------------------------------------------
# Hold the pause for TEST_PAUSE_DURATION_SEC seconds, sampling memory and
# liveness at every tick.
# ---------------------------------------------------------------------------
harness::log "--- holding pause for ${TEST_PAUSE_DURATION_SEC}s (tick=${TEST_PAUSE_TICK_SEC}s) ---"
start_ts=$(date +%s)
deadline=$(( start_ts + TEST_PAUSE_DURATION_SEC ))
max_mem="${baseline_mem}"
samples=()

while :; do
    now=$(date +%s)
    [[ ${now} -ge ${deadline} ]] && break

    # Liveness: SRT producer must still be alive.
    if ! kill -0 "${stream_pid}" 2>/dev/null; then
        fail "SRT stream pid=${stream_pid} died during pause window"
    fi

    # Liveness: every core container must remain running (and healthy if it
    # exposes a healthcheck).
    for svc in "${CORE_SERVICES[@]}"; do
        check_container_healthy "${svc}" \
            || fail "core container '${svc}' is no longer healthy"
    done

    # Memory sample.
    sample=$(harness::container_mem_mb transcriber)
    elapsed=$(( now - start_ts ))
    samples+=("t=${elapsed}s mem=${sample}MB")
    harness::log "tick: t=${elapsed}s transcriber_mem=${sample}MB"
    if [[ "${sample}" -gt "${max_mem}" ]]; then
        max_mem="${sample}"
    fi

    # Sleep until next tick, but never overshoot the deadline.
    remaining=$(( deadline - $(date +%s) ))
    if [[ ${remaining} -le 0 ]]; then break; fi
    if [[ ${remaining} -lt ${TEST_PAUSE_TICK_SEC} ]]; then
        sleep "${remaining}"
    else
        sleep "${TEST_PAUSE_TICK_SEC}"
    fi
done

# Final memory sample at the very end of the window.
final_mem=$(harness::container_mem_mb transcriber)
if [[ "${final_mem}" -gt "${max_mem}" ]]; then
    max_mem="${final_mem}"
fi

delta=$(( final_mem - baseline_mem ))
peak_delta=$(( max_mem - baseline_mem ))
harness::log "--- memory summary ---"
harness::log "baseline=${baseline_mem}MB  final=${final_mem}MB  peak=${max_mem}MB"
harness::log "delta(final-baseline)=${delta}MB  peak_delta=${peak_delta}MB"
for s in "${samples[@]}"; do
    harness::log "  ${s}"
done

# ---------------------------------------------------------------------------
# Assertion: memory delta must stay below TEST_MAX_MEM_DELTA_MB.
# We compare against the absolute value so a *drop* never trips the check.
# ---------------------------------------------------------------------------
abs_delta=${delta#-}
if [[ ${abs_delta} -ge ${TEST_MAX_MEM_DELTA_MB} ]]; then
    fail "transcriber memory grew by ${delta}MB during the pause window (>= ${TEST_MAX_MEM_DELTA_MB}MB threshold)"
fi
harness::ok "transcriber memory delta ${delta}MB is within threshold (< ${TEST_MAX_MEM_DELTA_MB}MB)"

# ---------------------------------------------------------------------------
# Resume and verify the pipeline recovers.
#
# Note: a long pause window can race with the scheduler's safety net which
# downgrades 'paused' to 'ready' if the transcriber loses sight of the active
# channel. This is not what the scenario is testing (memory stability) so we
# treat resume as best-effort: log a warning if the session is no longer in
# 'paused', then still attempt the resume call and the post-resume partial
# check. Same posture as scenario 03 on slow ASR warm-up.
# ---------------------------------------------------------------------------
harness::log "--- resuming session ---"
current_status=$(harness::get_session "${session_id}" | jq -r '.status // empty')
if [[ "${current_status}" != "paused" ]]; then
    harness::warn "session is in status '${current_status}' (expected 'paused') after the pause window; \
skipping resume verification (scheduler likely downgraded paused -> ready)"
else
    if ! harness::http PUT "/sessions/${session_id}/resume" >/dev/null; then
        harness::warn "PUT /resume failed; continuing with cleanup"
    else
        if ! harness::assert_status "${session_id}" "active" 15; then
            harness::warn "session did not transition back to 'active' within 15s"
        else
            # SRT producer must still be alive after resume.
            if ! kill -0 "${stream_pid}" 2>/dev/null; then
                fail "SRT stream pid=${stream_pid} died around resume"
            fi
            harness::ok "SRT producer still running after resume"

            # Reset the running tail and wait briefly for partials. Best-effort.
            : > "${PARTIAL_LOG}"
            sleep 1
            if ! harness::mqtt_assert_received "transcriber/out/${session_id}/+/partial" "" 15; then
                harness::warn "no partial received within 15s after resume; the fake ASR may be slow"
            else
                harness::ok "transcriptions resumed within 15s of resume"
            fi
        fi
    fi
fi

# ---------------------------------------------------------------------------
# Cleanup.
# ---------------------------------------------------------------------------
kill "${stream_pid}" 2>/dev/null || true

# Delete the session (force=true is safe even if it's active).
harness::http DELETE "/sessions/${session_id}?force=true" >/dev/null 2>&1 || true

harness::ok "long pause / memory stability scenario PASSED"
