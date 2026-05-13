#!/usr/bin/env bash
# tests/integration/scenarios/15-pause-sender-stop-per-protocol.sh
#
# Validates the TCP-vs-UDP session-lifetime asymmetry documented in
# doc/streaming-protocols.md, in the specific context of a paused session
# whose sender stops streaming.
#
#   SRT (UDP):
#     Pause + kill streamer → channel streamStatus stays 'active' for up
#     to channelTimeoutSeconds (5s), then the inactivity sentinel
#     (checkTimedOutChannel) tears the channel down and streamStatus
#     flips to 'inactive'. Session status stays 'paused' (Scheduler CASE
#     SQL preserves paused across stream updates).
#
#   WS / RTMP (TCP):
#     Pause + kill streamer (SIGTERM lets the client close the socket
#     cleanly) → the server reacts to ws.on('close') / NMS donePublish
#     immediately, channel streamStatus flips to 'inactive' within ~2s.
#
# The asymmetry is intentional — see doc/streaming-protocols.md "Why we
# keep the asymmetry".

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../harness/lib.sh
source "${SCRIPT_DIR}/../harness/lib.sh"

harness::install_cleanup_trap

fail() {
    harness::err "FAIL: $*"
    exit 1
}

# Wait until session.channels[0].streamStatus reaches EXPECTED, or TIMEOUT
# elapses. Echoes the final value. Returns 0 on match, 1 on timeout.
wait_for_channel_stream_status() {
    local id="$1"
    local expected="$2"
    local timeout="${3:-15}"
    local deadline=$(( $(date +%s) + timeout ))
    local last=""
    while :; do
        last=$(harness::get_session "${id}" | jq -r '.channels[0].streamStatus // empty' 2>/dev/null || echo "")
        if [[ "${last}" == "${expected}" ]]; then
            echo "${last}"
            return 0
        fi
        if [[ $(date +%s) -ge ${deadline} ]]; then
            echo "${last}"
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

harness::log "=== pause + sender-stop per protocol scenario ==="

profile_id=$(harness::create_transcriber_profile "sender_stop_fake")
harness::ok "created transcriber profile id=${profile_id}"

# ---------------------------------------------------------------------------
# Generic per-protocol assertion
#
# $1 = protocol label  ("SRT", "WS", "RTMP")
# $2 = stream helper   ("harness::stream_srt_loop", ...)
# $3 = expected inactive deadline (seconds). For SRT we need 5s timeout +
#      buffer; for WS/RTMP the close is immediate so ~5s is plenty.
# ---------------------------------------------------------------------------
run_case() {
    local proto="$1"
    local stream_helper="$2"
    local inactive_deadline="$3"

    harness::log "--- ${proto}: pause + sender stop ---"

    local session_id
    session_id=$(harness::create_session "${profile_id}" "stop_${proto,,}_$(date +%s)")
    harness::assert_status "${session_id}" "ready" 15 \
        || fail "${proto}: session not ready"

    local stream_pid
    stream_pid=$(${stream_helper} "${session_id}" 0 "${SCRIPT_DIR}/../fixtures/audio.wav" 0)
    harness::log "${proto}: streamer pid=${stream_pid}"

    harness::assert_status "${session_id}" "active" 30 \
        || { kill "${stream_pid}" 2>/dev/null || true; fail "${proto}: never reached active"; }

    # Pre-condition: channel must be active before we pause.
    local pre_status
    pre_status=$(wait_for_channel_stream_status "${session_id}" "active" 15) \
        || { kill "${stream_pid}" 2>/dev/null || true; fail "${proto}: channel never went active (got '${pre_status}')"; }
    harness::ok "${proto}: channel.streamStatus=active before pause"

    # Pause the session.
    harness::put "/sessions/${session_id}/pause" >/dev/null \
        || { kill "${stream_pid}" 2>/dev/null || true; fail "${proto}: pause failed"; }
    harness::assert_status "${session_id}" "paused" 15 \
        || { kill "${stream_pid}" 2>/dev/null || true; fail "${proto}: never reached paused"; }
    harness::ok "${proto}: session paused"

    # Kill the sender with SIGTERM so the client has a chance to close the
    # socket cleanly (matters for WS/RTMP — SIGKILL would leave the TCP half-
    # open and we'd hit the longer ping timeout instead of the FIN path).
    harness::log "${proto}: terminating streamer pid=${stream_pid}"
    kill "${stream_pid}" 2>/dev/null || true

    # Now the protocol-specific deadline: SRT needs the 5s inactivity
    # sentinel, WS/RTMP detect the close immediately.
    local final
    if final=$(wait_for_channel_stream_status "${session_id}" "inactive" "${inactive_deadline}"); then
        harness::ok "${proto}: channel.streamStatus=inactive within ${inactive_deadline}s"
    else
        fail "${proto}: channel.streamStatus did not reach inactive within ${inactive_deadline}s (got '${final}')"
    fi

    # The Scheduler's CASE SQL preserves paused across stream updates.
    local final_session
    final_session=$(harness::get_session "${session_id}" | jq -r '.status // empty')
    if [[ "${final_session}" != "paused" ]]; then
        fail "${proto}: session status changed to '${final_session}' (expected to stay 'paused')"
    fi
    harness::ok "${proto}: session.status preserved as paused"

    # Cleanup.
    harness::http DELETE "/sessions/${session_id}?force=true" >/dev/null 2>&1 || true
    # Small breather so the next case starts from a clean broker snapshot.
    sleep 1
}

# SRT: must allow 5s timeout + buffer. We use 10s to absorb the 1s polling
# tick and the 1s tear-down propagation through the broker.
run_case "SRT"  "harness::stream_srt_loop"  10

# WS: TCP FIN propagates fast, but the gstreamer-side flush + ws.on('close')
# still needs a couple of seconds end-to-end.
run_case "WS"   "harness::stream_ws_loop"   8

# RTMP: ffmpeg sends RTMP "deletestream" on SIGTERM → donePublish → cleanup.
# Same expected timing as WS.
run_case "RTMP" "harness::stream_rtmp_loop" 8

harness::ok "=== pause + sender-stop asymmetry verified across SRT / WS / RTMP ==="
