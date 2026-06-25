#!/usr/bin/env bash
# tests/integration/scenarios/20-simultaneous-cutoff.sh
#
# Regression scenario for the cross-channel session-status race
# (real prod incident 2026-06-23, session "ECON-EMPL Joint Meeting", 3 channels).
#
# When ALL channels of a session go inactive within a few tens of ms (every SRT
# stream cut at once), the per-channel chainChannelPersist key lets the sibling
# updateSession transactions run concurrently. Under READ COMMITTED each one's
# active-channel COUNT(*) runs on a snapshot where the siblings' 'inactive'
# writes aren't committed yet, so none observes count=0 and the session is left
# stuck status='active' forever (channels all inactive, no transcriber).
#
# The fix takes a pessimistic SELECT ... FOR UPDATE row lock on the session at
# the top of updateSession, serializing the siblings so the LAST deactivation
# sees count=0 and flips the session to 'ready'.
#
# This is the ONLY surface that reproduces the race: it needs a real Postgres
# under READ COMMITTED. On UNPATCHED code the key assertion below (session must
# reach 'ready' within the timeout) FAILS — the session stays 'active'.
#
# Uses a MANUAL session (autoEnd defaults to false via create_session_multi) on
# purpose: the autoEnd sweeper only terminates autoEnd=true sessions, so it would
# otherwise mask the bug.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../harness/lib.sh
source "${SCRIPT_DIR}/../harness/lib.sh"

harness::install_cleanup_trap

# 3 channels, matching the production incident (channels 633/634/635).
NUM_CHANNELS=3
# SRT tears down ~5s after the stream stops (doc/streaming-protocols.md); the
# Scheduler then publishes the inactive events. Allow generous slack on top.
READY_TIMEOUT=30

fail() {
    harness::err "FAIL: $*"
    exit 1
}

# Bring the stack up only if needed.
if ! harness::_compose ps --status running --services 2>/dev/null | grep -q '^sessionapi$'; then
    harness::log "stack not running, bringing it up"
    harness::up || { harness::err "stack failed to come up"; exit 1; }
fi

harness::log "=== simultaneous-cutoff race regression (channels=${NUM_CHANNELS}) ==="

# ---------------------------------------------------------------------------
# Setup: one profile, one MANUAL session with N channels.
# ---------------------------------------------------------------------------
profile_id=$(harness::create_transcriber_profile "simultaneous_cutoff_fake")
harness::ok "created transcriber profile id=${profile_id}"

session_id=$(harness::create_session_multi "${profile_id}" "${NUM_CHANNELS}" \
    "simultaneous_cutoff_$(date +%s)")
harness::ok "created multi-channel session id=${session_id}"

harness::assert_status "${session_id}" "ready" 30 \
    || fail "initial multi-channel session status should be ready"

# ---------------------------------------------------------------------------
# Bring every channel up: one SRT stream per channel index, in parallel.
# ---------------------------------------------------------------------------
harness::log "--- starting ${NUM_CHANNELS} SRT streams towards ${session_id} ---"
stream_pids=()
for (( i=0; i<NUM_CHANNELS; i++ )); do
    pid=$(harness::stream_srt_loop "${session_id}" "${i}")
    stream_pids+=("${pid}")
    harness::log "channel index=${i} SRT stream pid=${pid}"
done

# Wait until the session flips to 'active'.
if ! harness::assert_status "${session_id}" "active" 60; then
    harness::logs scheduler 60 || true
    harness::logs transcriber 80 || true
    fail "session did not become 'active' within 60s of streaming"
fi
harness::ok "session is active"

# Give all channels time to actually mount their streams (so all N really are
# active in the DB before we cut them — otherwise the race window may not form).
sleep 5

active_channels=$(harness::get_session "${session_id}" \
    | jq '[.channels[] | select(.streamStatus == "active")] | length')
harness::log "active channels before cutoff: ${active_channels}/${NUM_CHANNELS}"
if [[ "${active_channels}" -lt 2 ]]; then
    harness::warn "fewer than 2 channels active; the cross-channel race needs >=2 concurrent deactivations"
fi

# ---------------------------------------------------------------------------
# THE TRIGGER: cut ALL streams in a SINGLE kill call so the SRT teardowns —
# and therefore the Scheduler's 'channel inactive' events — land together.
# ---------------------------------------------------------------------------
harness::log "--- cutting ALL ${NUM_CHANNELS} streams simultaneously ---"
kill -TERM "${stream_pids[@]}" 2>/dev/null || true

# Wait for every channel to be observed inactive (SRT teardown ~5s).
harness::log "--- waiting for all channels to go inactive ---"
deadline=$(( $(date +%s) + 25 ))
while :; do
    remaining=$(harness::get_session "${session_id}" \
        | jq '[.channels[] | select(.streamStatus == "active")] | length' 2>/dev/null || echo "?")
    if [[ "${remaining}" == "0" ]]; then
        harness::ok "all channels are inactive"
        break
    fi
    if [[ $(date +%s) -ge ${deadline} ]]; then
        harness::err "channels still active after cutoff: ${remaining}"
        harness::get_session "${session_id}" | jq '.channels[] | {id, streamStatus, transcriberId}' >&2 || true
        fail "channels did not deactivate after simultaneous cutoff"
    fi
    sleep 1
done

# ---------------------------------------------------------------------------
# KEY ASSERTION: with all channels inactive, the session MUST drop to 'ready'.
# On the buggy code it stays 'active' forever — this is the regression guard.
# ---------------------------------------------------------------------------
harness::log "--- asserting session recovers to 'ready' (regression guard) ---"
if ! harness::assert_status "${session_id}" "ready" "${READY_TIMEOUT}"; then
    harness::err "session stuck — channels inactive but status not 'ready' (the race bug)"
    harness::get_session "${session_id}" | jq '{status, channels: [.channels[] | {id, streamStatus, transcriberId}]}' >&2 || true
    harness::logs scheduler 80 || true
    fail "session did not recover to 'ready' within ${READY_TIMEOUT}s after simultaneous cutoff"
fi
harness::ok "session correctly returned to 'ready' after simultaneous cutoff"

# endTime must NOT be set on a 'ready' (non-terminal) session.
end_time=$(harness::get_session "${session_id}" | jq -r '.endTime // "null"')
if [[ "${end_time}" != "null" ]]; then
    harness::warn "endTime is set on a 'ready' session (${end_time}); expected null until terminated"
else
    harness::ok "endTime is null while 'ready' (as expected)"
fi

# ---------------------------------------------------------------------------
# Secondary check: now that the session reaches 'ready' reliably, stop() must
# terminate it (and stamp endTime). Best-effort — the primary guard is above.
# ---------------------------------------------------------------------------
harness::log "--- stopping the session to confirm it can terminate ---"
harness::stop_session "${session_id}" || harness::warn "stop request failed"
if harness::assert_status "${session_id}" "terminated" 15; then
    end_time=$(harness::get_session "${session_id}" | jq -r '.endTime // "null"')
    if [[ "${end_time}" != "null" ]]; then
        harness::ok "terminated session has endTime=${end_time}"
    else
        harness::warn "terminated session has no endTime"
    fi
else
    harness::warn "session did not reach 'terminated' after stop (non-fatal for this regression)"
fi

# ---------------------------------------------------------------------------
# Cleanup.
# ---------------------------------------------------------------------------
harness::http DELETE "/sessions/${session_id}?force=true" >/dev/null 2>&1 || true

harness::ok "simultaneous-cutoff race regression scenario PASSED"
