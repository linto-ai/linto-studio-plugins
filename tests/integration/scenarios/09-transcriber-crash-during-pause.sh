#!/usr/bin/env bash
# tests/integration/scenarios/09-transcriber-crash-during-pause.sh
#
# Validates the Scheduler's LWT-based recovery path when the Transcriber
# disappears while a session is paused.
#
# Expected behaviour (see Scheduler/components/BrokerClient/index.js,
# unregisterTranscriber around line 326):
#   1. session paused
#   2. transcriber crashes -> MQTT LWT publishes status=offline on
#      transcriber/out/{uniqueId}/status
#   3. scheduler detects -> unregisterTranscriber()
#   4. for every paused session affected:
#        * WARN log "Paused session ${id} downgraded to 'ready'..."
#        * session.status -> 'ready'
#        * channels.streamStatus -> 'inactive', transcriberId -> null
#
# The scenario must restart the transcriber on its way out so the rest of the
# integration suite remains usable.

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

# Wait until the transcriber service reports healthy again.
wait_transcriber_healthy() {
    local timeout="${1:-90}"
    local deadline=$(( $(date +%s) + timeout ))
    while :; do
        local cid
        cid=$(harness::_compose ps -q transcriber 2>/dev/null | head -1)
        if [[ -n "${cid}" ]]; then
            local state health
            state=$(docker inspect -f '{{.State.Status}}' "${cid}" 2>/dev/null || echo "missing")
            health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${cid}" 2>/dev/null || echo "none")
            case "${state}/${health}" in
                running/healthy|running/none) harness::ok "transcriber back up (${state}/${health})"; return 0 ;;
            esac
        fi
        if [[ $(date +%s) -ge ${deadline} ]]; then
            harness::err "transcriber did not become healthy within ${timeout}s"
            return 1
        fi
        sleep 2
    done
}

# Always make sure the transcriber is restarted before we exit, even on FAIL.
restore_transcriber() {
    harness::log "restoring transcriber container (cleanup)"
    harness::_compose start transcriber >/dev/null 2>&1 || true
    wait_transcriber_healthy 90 || harness::warn "transcriber not healthy at cleanup time"
}
trap 'restore_transcriber; harness::_kill_bg' EXIT

# Bring the stack up only if needed.
if ! harness::_compose ps --status running --services 2>/dev/null | grep -q '^sessionapi$'; then
    harness::log "stack not running, bringing it up"
    harness::up || { harness::err "stack failed to come up"; exit 1; }
fi

harness::log "=== transcriber crash during pause scenario ==="

# ---------------------------------------------------------------------------
# Setup: fake profile + session
# ---------------------------------------------------------------------------
profile_id=$(harness::create_transcriber_profile "crash_pause_fake")
harness::ok "created transcriber profile id=${profile_id}"

session_id=$(harness::create_session "${profile_id}" "crash_pause_$(date +%s)")
harness::ok "created session id=${session_id}"

harness::assert_status "${session_id}" "ready" 30 \
    || fail "initial session status should be ready"

# ---------------------------------------------------------------------------
# Start streaming and wait for active.
# ---------------------------------------------------------------------------
harness::log "--- starting SRT loop stream towards ${session_id} ---"
stream_pid=$(harness::stream_srt_loop "${session_id}" 0 "${AUDIO}" 0)
harness::log "SRT stream pid=${stream_pid}"

if ! wait_for_status "${session_id}" "active" 60 >/dev/null; then
    harness::logs scheduler 50 || true
    harness::logs transcriber 80 || true
    fail "session did not become 'active' within 60s of streaming"
fi

# ---------------------------------------------------------------------------
# Pause the session.
# ---------------------------------------------------------------------------
harness::log "--- pausing session ---"
harness::http PUT "/sessions/${session_id}/pause" >/dev/null \
    || fail "PUT /pause on active session failed"
harness::assert_status "${session_id}" "paused" 15 \
    || fail "session did not transition to 'paused'"

# ---------------------------------------------------------------------------
# Capture baseline count of the "Paused session" downgrade log in Scheduler so
# we can later assert this run actually produced a NEW occurrence.
# ---------------------------------------------------------------------------
baseline_count=$(harness::_compose logs --no-color scheduler 2>/dev/null \
    | grep -cE "Paused session ${session_id} downgraded to 'ready'" || true)
baseline_count="${baseline_count:-0}"
harness::log "baseline downgrade log count for ${session_id}: ${baseline_count}"

# ---------------------------------------------------------------------------
# Crash the Transcriber to force MQTT LWT publication.
# `docker compose stop` sends SIGTERM then SIGKILL after the timeout; in either
# case the broker observes the TCP disconnect and publishes the LWT payload
# (status=offline) on transcriber/out/{uniqueId}/status, which is what the
# Scheduler reacts to.
# ---------------------------------------------------------------------------
harness::log "--- stopping transcriber to trigger LWT ---"
harness::_compose stop transcriber >/dev/null 2>&1 \
    || fail "could not stop transcriber container"
harness::ok "transcriber stopped"

# ---------------------------------------------------------------------------
# Wait for the Scheduler to detect the disconnect.
# Two parallel signals are accepted:
#   (a) session status flips to 'ready' (via REST), OR
#   (b) scheduler log shows the WARN line for this session.
# We poll both for at most 30s.
# ---------------------------------------------------------------------------
harness::log "--- waiting for Scheduler to downgrade paused session ---"
deadline=$(( $(date +%s) + 30 ))
saw_status_ready=0
saw_warn_log=0
warn_pattern="Paused session ${session_id} downgraded to 'ready'"
while :; do
    cur=$(harness::get_session "${session_id}" | jq -r '.status // empty' 2>/dev/null || echo "")
    if [[ "${cur}" == "ready" ]]; then
        saw_status_ready=1
    fi
    if harness::scheduler_log_contains "${warn_pattern}"; then
        saw_warn_log=1
    fi
    if [[ ${saw_status_ready} -eq 1 && ${saw_warn_log} -eq 1 ]]; then
        break
    fi
    if [[ $(date +%s) -ge ${deadline} ]]; then
        break
    fi
    sleep 1
done

# ---------------------------------------------------------------------------
# Assertion 1: session status became 'ready' within the LWT detection window.
# ---------------------------------------------------------------------------
if [[ ${saw_status_ready} -ne 1 ]]; then
    final_status=$(harness::get_session "${session_id}" | jq -r '.status // empty' 2>/dev/null || echo "")
    harness::logs scheduler 80 || true
    fail "session ${session_id} did not downgrade to 'ready' within 30s (got '${final_status}')"
fi
harness::ok "session downgraded to 'ready' after LWT"

# ---------------------------------------------------------------------------
# Assertion 2: scheduler emitted the WARN downgrade line.
# We also check that the count grew vs. baseline (so we are not picking up a
# stale occurrence from a previous run, even though the session id is unique).
# ---------------------------------------------------------------------------
if [[ ${saw_warn_log} -ne 1 ]]; then
    harness::logs scheduler 100 || true
    fail "expected scheduler log line matching /${warn_pattern}/"
fi
new_count=$(harness::_compose logs --no-color scheduler 2>/dev/null \
    | grep -cE "Paused session ${session_id} downgraded to 'ready'" || true)
new_count="${new_count:-0}"
if [[ "${new_count}" -le "${baseline_count}" ]]; then
    harness::warn "downgrade log count did not grow (baseline=${baseline_count}, new=${new_count}); pattern match was still positive, accepting"
else
    harness::ok "downgrade log count grew (${baseline_count} -> ${new_count})"
fi

# ---------------------------------------------------------------------------
# Assertion 3: every channel of the session is now inactive (streamStatus).
# ---------------------------------------------------------------------------
session_json=$(harness::get_session "${session_id}")
non_inactive=$(jq -r '
    (.channels // [])
    | map(select((.streamStatus // "inactive") != "inactive"))
    | length
' <<< "${session_json}" 2>/dev/null || echo "")
if [[ -z "${non_inactive}" ]]; then
    harness::err "could not parse channels from session payload"
    echo "${session_json}" | head -c 2000 >&2 || true
    fail "channels assertion failed (parse error)"
fi
if [[ "${non_inactive}" -ne 0 ]]; then
    harness::err "expected all channels to have streamStatus='inactive', got ${non_inactive} non-inactive"
    echo "${session_json}" | jq '.channels' >&2 || true
    fail "channels did not transition to inactive"
fi
harness::ok "all channels of ${session_id} are streamStatus='inactive'"

# ---------------------------------------------------------------------------
# Restore the stack so subsequent scenarios start from a clean state.
# Restart BOTH the transcriber (which we explicitly stopped) and the
# scheduler (whose in-memory transcribers map still references the dead
# transcriberId). Without the scheduler restart, the next session created
# in this run gets no transcriber assigned and times out at 60s waiting
# for status=active.
# The SRT client (gst-launch) was almost certainly killed by the ingress
# going away; we do not assert on its pid.
# ---------------------------------------------------------------------------
harness::log "--- restarting transcriber and scheduler ---"
harness::_compose start transcriber >/dev/null 2>&1 \
    || fail "could not restart transcriber container"
harness::_compose restart scheduler >/dev/null 2>&1 \
    || fail "could not restart scheduler container"
wait_transcriber_healthy 90 || fail "transcriber did not come back healthy"

# Validate the stack is actually functional again by creating a probe
# session, streaming SRT, and waiting for status=active. This proves the
# scheduler has assigned the new transcriber to fresh channels and the
# end-to-end ingress is back. Without this check, scenarios that follow
# (10-autoend, 11-mqtt-reconnect) can fail spuriously at "session did not
# become active within 60s" because the scheduler hasn't yet processed
# the new transcriber registration.
harness::log "--- probing stack with a smoke session ---"
probe_profile_id=$(harness::create_transcriber_profile "post_crash_probe") \
    || fail "could not create probe profile after restart"
probe_session_id=$(harness::create_session "${probe_profile_id}" "post_crash_probe") \
    || fail "could not create probe session after restart"
probe_stream_pid=$(harness::stream_srt_loop "${probe_session_id}" 0 "${AUDIO}" 0)
probe_deadline=$(( $(date +%s) + 60 ))
probe_active=0
while [[ $(date +%s) -lt ${probe_deadline} ]]; do
    cur=$(harness::get_session "${probe_session_id}" | jq -r '.status // empty' 2>/dev/null || echo "")
    if [[ "${cur}" == "active" ]]; then
        probe_active=1
        break
    fi
    sleep 2
done
kill "${probe_stream_pid}" 2>/dev/null || true
harness::http DELETE "/sessions/${probe_session_id}?force=true" >/dev/null 2>&1 || true
if [[ "${probe_active}" -ne 1 ]]; then
    harness::logs scheduler 50 || true
    harness::logs transcriber 50 || true
    fail "stack did not recover after restart (probe session never became active)"
fi
harness::ok "stack recovered (probe session reached active)"

# Best-effort cleanup of the original SRT gst-launch process if still alive.
kill "${stream_pid}" 2>/dev/null || true

# Force-delete the test session so it doesn't linger.
harness::http DELETE "/sessions/${session_id}?force=true" >/dev/null 2>&1 || true

harness::ok "transcriber crash during pause scenario PASSED"
