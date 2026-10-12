#!/usr/bin/env bash
# tests/integration/scenarios/22-session-end-drain.sh
#
# A session ended by the Scheduler must not announce its end before the
# channels' last captions and kept audio are stored. studio-api reacts to
# system/out/sessions/ended by reading the captions and deleting the session,
# and by converting then deleting the kept WAV (or measuring the MP3 once), so
# anything stored after the notification is lost (seen live: a Teams bot
# auto-leaving an empty meeting lost the end-of-stream flush to a
# captions_channelId_fkey violation).
#
# Reference: Scheduler/components/BrokerClient/index.js endBotSession() ->
# endSessions() -> waitSessionDrained(); Transcriber StreamingServer._stopAsr().
#
# Scenario (FAKE asr, no secrets, no BotService), once with the default kept
# audio (MP3) and once with an uncompressed one (WAV):
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
#      stored. The channel's kept audio file must be complete: present, and its
#      raw .pcm file gone (removed once the transcode is done). Exactly one
#      sessions/ended is published.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../harness/lib.sh
source "${SCRIPT_DIR}/../harness/lib.sh"

harness::install_cleanup_trap

TEST_ENDED_TIMEOUT_SEC="${TEST_ENDED_TIMEOUT_SEC:-30}"
# Audio streamed before the bot leaves, so the kept file is not trivial.
TEST_STREAM_SEC="${TEST_STREAM_SEC:-5}"
AUDIO_STORAGE=/audio-storage

fail() {
    harness::err "FAIL: $*"
    exit 1
}

if ! harness::_compose ps --status running --services 2>/dev/null | grep -q '^sessionapi$'; then
    harness::log "stack not running, bringing it up"
    harness::up || { harness::err "stack failed to come up"; exit 1; }
fi

ENDED_LOG=$(mktemp)
trap 'rm -f "${ENDED_LOG}"; harness::_kill_bg' EXIT
harness::mqtt_subscribe "system/out/sessions/ended" "${ENDED_LOG}" >/dev/null
sleep 1   # let the subscription settle

profile_id=$(harness::create_transcriber_profile "end_drain_fake")

# Run inside the transcriber container (its audio storage is not mounted).
in_transcriber() {
    harness::_compose exec -T transcriber sh -c "$1"
}

# end_bot_session LABEL COMPRESS_AUDIO EXT
end_bot_session() {
    local label="$1" compress="$2" ext="$3"
    harness::log "=== session end drain: bot auto-leave, kept audio ${ext} ==="

    local payload created session_id channel_id bot_payload bot bot_id
    payload=$(jq -nc --arg name "end_drain_${label}_$(date +%s)" --argjson profile "${profile_id}" --argjson compress "${compress}" \
        '{name: $name, channels: [{name: "ch0", transcriberProfileId: $profile, keepAudio: true, compressAudio: $compress}]}')
    created=$(harness::post "/sessions" "${payload}") || fail "POST /sessions failed"
    session_id=$(jq -r '.id // empty' <<< "${created}")
    [[ -n "${session_id}" ]] || fail "could not read the session id from: ${created}"
    harness::assert_status "${session_id}" "ready" 30 || fail "session should start ready"
    channel_id=$(harness::get_session "${session_id}" | jq -r '.channels[0].id')
    [[ -n "${channel_id}" && "${channel_id}" != "null" ]] || fail "could not read the channel id"

    bot_payload=$(jq -nc --argjson ch "${channel_id}" \
        '{url: "https://meet.example.com/end-drain", channelId: $ch, provider: "visio", enableDisplaySub: false}')
    bot=$(harness::post "/bots" "${bot_payload}") || fail "POST /bots failed"
    bot_id=$(jq -r '.id // empty' <<< "${bot}")
    [[ -n "${bot_id}" ]] || fail "could not read the bot id from: ${bot}"
    harness::ok "bot row ${bot_id} on channel ${channel_id}"

    local stream_pid
    stream_pid=$(harness::stream_srt_loop "${session_id}" 0 "" 0)
    harness::assert_status "${session_id}" "active" 60 || {
        harness::logs transcriber 80 || true
        fail "session did not become active"
    }
    sleep "${TEST_STREAM_SEC}"

    harness::log "--- bot leaves the empty meeting: stopbot {botId: ${bot_id}, endSession: true} ---"
    mosquitto_pub -h "${HARNESS_MQTT_HOST}" -p "${HARNESS_MQTT_PORT}" -q 1 \
        -t "scheduler/in/schedule/stopbot" -m "{\"botId\": ${bot_id}, \"endSession\": true}"

    local deadline=$(( $(date +%s) + TEST_ENDED_TIMEOUT_SEC ))
    until grep -qF "${session_id}" "${ENDED_LOG}"; do
        if [[ $(date +%s) -ge ${deadline} ]]; then
            harness::logs scheduler 100 || true
            fail "no system/out/sessions/ended for ${session_id} within ${TEST_ENDED_TIMEOUT_SEC}s"
        fi
        sleep 0.1
    done
    # Check right away: whatever is not stored yet would be lost to a consumer
    # that deletes the session (and the WAV) on this notification.
    local result kept
    result=$(harness::get "/sessions/${session_id}?withCaptions=true")
    kept="${AUDIO_STORAGE}/${session_id}-${channel_id}"
    in_transcriber "test -s '${kept}.${ext}' && ! ls '${kept}'-*.pcm >/dev/null 2>&1" || {
        in_transcriber "ls -la ${AUDIO_STORAGE}" >&2 || true
        fail "the kept ${ext} file was not complete at sessions/ended time"
    }
    harness::ok "system/out/sessions/ended received; kept ${ext} complete"

    local status stream_status markers
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

    if [[ "${ext}" == "wav" ]]; then
        local duration
        duration=$(in_transcriber "ffprobe -v error -show_entries format=duration -of csv=p=0 '${kept}.wav'")
        awk -v d="${duration}" -v min="$(( TEST_STREAM_SEC - 2 ))" 'BEGIN { exit !(d >= min) }' \
            || fail "kept WAV lasts ${duration}s, expected at least $(( TEST_STREAM_SEC - 2 ))s"
        harness::ok "kept WAV readable, ${duration}s"
    fi

    harness::scheduler_log_contains "Session ${session_id} ended and drained" \
        || fail "scheduler did not log the drained end"
    # Ordering, independent of how fast this check ran: the kept audio was
    # saved before the Scheduler published the end (same clock, ISO timestamps).
    local saved_at ended_at
    saved_at=$(harness::logs transcriber 2000 | grep -F "Audio file saved as ${kept}.${ext}" | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z' | head -1 || true)
    ended_at=$(harness::logs scheduler 2000 | grep -F "Session ${session_id} ended and drained" | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z' | head -1 || true)
    [[ -n "${saved_at}" && -n "${ended_at}" ]] || fail "missing log timestamps (saved='${saved_at}', ended='${ended_at}')"
    [[ ! "${saved_at}" > "${ended_at}" ]] \
        || fail "kept ${ext} saved at ${saved_at}, after sessions/ended was published at ${ended_at}"
    harness::ok "kept ${ext} saved at ${saved_at}, sessions/ended published at ${ended_at}"
    if harness::scheduler_log_contains "Session ${session_id}: channel\\(s\\) still active"; then
        fail "the drain timed out instead of observing the deactivation"
    fi

    sleep 2   # a duplicate would follow the first notification closely
    local ended_count
    ended_count=$(grep -cF "${session_id}" "${ENDED_LOG}" || true)
    [[ "${ended_count}" -eq 1 ]] || fail "sessions/ended published ${ended_count} times, expected once"
    harness::ok "sessions/ended published exactly once"

    kill "${stream_pid}" 2>/dev/null || true
}

end_bot_session mp3 true mp3
end_bot_session wav false wav
harness::ok "session end drain scenario PASSED"
