#!/usr/bin/env bash
# tests/integration/scenarios/22-session-end-drain.sh
#
# A session ended by the Scheduler must not announce its end before the
# channels' last captions are stored. studio-api reacts to
# system/out/sessions/ended by reading the captions and deleting the session,
# so anything persisted after the notification is lost (seen live: a Teams bot
# auto-leaving an empty meeting lost the end-of-stream flush to a
# captions_channelId_fkey violation).
#
# Reference: Scheduler/components/BrokerClient/index.js endBotSession() ->
# endSessions() -> waitSessionDrained().
#
# Scenario (FAKE asr, no secrets, no BotService):
#   1. Create a session and a bot row on its channel (no BotService is running,
#      so the startbot is not routed: only the row matters), then stream to the
#      channel over SRT so it goes active.
#   2. Publish what a BotService publishes when the meeting empties out:
#      scheduler/in/schedule/stopbot {botId, endSession:true}. The SRT sender
#      keeps streaming, so the Scheduler itself must get the stream cut.
#   3. As soon as system/out/sessions/ended arrives, read the session: it must
#      be terminated, its channel inactive, and the end-of-stream marker the
#      Transcriber publishes when the stream stops (locutor "bot", aend set,
#      published right before its 'inactive' deactivation) must already be
#      stored. Exactly one sessions/ended is published.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../harness/lib.sh
source "${SCRIPT_DIR}/../harness/lib.sh"

harness::install_cleanup_trap

TEST_ENDED_TIMEOUT_SEC="${TEST_ENDED_TIMEOUT_SEC:-30}"

fail() {
    harness::err "FAIL: $*"
    exit 1
}

if ! harness::_compose ps --status running --services 2>/dev/null | grep -q '^sessionapi$'; then
    harness::log "stack not running, bringing it up"
    harness::up || { harness::err "stack failed to come up"; exit 1; }
fi

harness::log "=== session end drain scenario (bot auto-leave) ==="

profile_id=$(harness::create_transcriber_profile "end_drain_fake")
session_id=$(harness::create_session "${profile_id}" "end_drain_$(date +%s)")
harness::assert_status "${session_id}" "ready" 30 || fail "session should start ready"
channel_id=$(harness::get_session "${session_id}" | jq -r '.channels[0].id')
[[ -n "${channel_id}" && "${channel_id}" != "null" ]] || fail "could not read the channel id"

bot_payload=$(jq -nc --argjson ch "${channel_id}" \
    '{url: "https://meet.example.com/end-drain", channelId: $ch, provider: "visio", enableDisplaySub: false}')
bot=$(harness::post "/bots" "${bot_payload}") || fail "POST /bots failed"
bot_id=$(jq -r '.id // empty' <<< "${bot}")
[[ -n "${bot_id}" ]] || fail "could not read the bot id from: ${bot}"
harness::ok "bot row ${bot_id} on channel ${channel_id}"

ENDED_LOG=$(mktemp)
trap 'rm -f "${ENDED_LOG}"; harness::_kill_bg' EXIT
harness::mqtt_subscribe "system/out/sessions/ended" "${ENDED_LOG}" >/dev/null
sleep 1   # let the subscription settle

stream_pid=$(harness::stream_srt_loop "${session_id}" 0 "" 0)
harness::assert_status "${session_id}" "active" 60 || {
    harness::logs transcriber 80 || true
    fail "session did not become active"
}

harness::log "--- bot leaves the empty meeting: stopbot {botId: ${bot_id}, endSession: true} ---"
mosquitto_pub -h "${HARNESS_MQTT_HOST}" -p "${HARNESS_MQTT_PORT}" -q 1 \
    -t "scheduler/in/schedule/stopbot" -m "{\"botId\": ${bot_id}, \"endSession\": true}"

deadline=$(( $(date +%s) + TEST_ENDED_TIMEOUT_SEC ))
until grep -qF "${session_id}" "${ENDED_LOG}"; do
    if [[ $(date +%s) -ge ${deadline} ]]; then
        harness::logs scheduler 100 || true
        fail "no system/out/sessions/ended for ${session_id} within ${TEST_ENDED_TIMEOUT_SEC}s"
    fi
    sleep 0.1
done
# Read the session right away: whatever is not stored yet would be lost to a
# consumer that deletes the session on this notification.
result=$(harness::get "/sessions/${session_id}?withCaptions=true")
harness::ok "system/out/sessions/ended received"

status=$(jq -r '.status' <<< "${result}")
[[ "${status}" == "terminated" ]] || fail "session status is '${status}', expected terminated"
stream_status=$(jq -r '.channels[0].streamStatus' <<< "${result}")
[[ "${stream_status}" == "inactive" ]] || fail "channel streamStatus is '${stream_status}', expected inactive"
markers=$(jq -r '[.channels[0].closedCaptions[] | select(.locutor == "bot" and .aend != null)] | length' <<< "${result}")
if [[ "${markers}" -lt 1 ]]; then
    harness::err "closedCaptions at sessions/ended time: $(jq -c '.channels[0].closedCaptions' <<< "${result}")"
    harness::logs scheduler 60 || true
    harness::logs transcriber 60 || true
    fail "the end-of-stream marker was not stored before sessions/ended (stream not drained)"
fi
harness::ok "session terminated, channel inactive, end-of-stream marker stored before sessions/ended"

harness::scheduler_log_contains "Session ${session_id} ended and drained" \
    || fail "scheduler did not log the drained end"
if harness::scheduler_log_contains "Session ${session_id}: channel\\(s\\) still active"; then
    fail "the drain timed out instead of observing the deactivation"
fi

sleep 2   # a duplicate would follow the first notification closely
ended_count=$(grep -cF "${session_id}" "${ENDED_LOG}" || true)
[[ "${ended_count}" -eq 1 ]] || fail "sessions/ended published ${ended_count} times, expected once"
harness::ok "sessions/ended published exactly once"

kill "${stream_pid}" 2>/dev/null || true
harness::ok "session end drain scenario PASSED"
