#!/usr/bin/env bash
# tests/integration/scenarios/23-session-ended-durable.sh
#
# system/out/sessions/ended is owed by the Scheduler for a session it ends
# itself, and recorded durably (sessions.endedNotice): studio-api only stores
# the conversation on that notification.
#
# Reference: Scheduler/components/BrokerClient/index.js endBotSession() ->
# endSessions() -> publishSessionEnded(), recoverEndedNotices(); Session-API's
# PUT /sessions/:id/stop?waitFinal=true (Studio's storing stop) clears the
# marker.
#
# Scenario (FAKE asr, SRT, no BotService). The Transcriber is paused so that
# the channel stays active and the Scheduler's drain lasts:
#   A. The bot leaves an empty meeting (stopbot endSession), and the Scheduler
#      crashes in the middle of the drain (SIGKILL). Once started again, it
#      finishes the end: sessions/ended is published exactly once, and the
#      marker cleared.
#   B. Studio stops the session to store it (PUT /sessions/:id/stop with
#      waitFinal=true) while the Scheduler drains: Studio takes the ending
#      over, and the Scheduler publishes no sessions/ended.
#   C. A plain stop (PUT /sessions/:id/stop, nothing stored) while the
#      Scheduler drains: the Scheduler's sessions/ended still goes out, once.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../harness/lib.sh
source "${SCRIPT_DIR}/../harness/lib.sh"

harness::install_cleanup_trap

fail() {
    harness::err "FAIL: $*"
    exit 1
}

if ! harness::_compose ps --status running --services 2>/dev/null | grep -q '^sessionapi$'; then
    harness::log "stack not running, bringing it up"
    harness::up || { harness::err "stack failed to come up"; exit 1; }
fi

ENDED_LOG=$(mktemp)
trap 'rm -f "${ENDED_LOG}"; harness::_compose unpause transcriber >/dev/null 2>&1 || true; harness::_kill_bg' EXIT
harness::mqtt_subscribe "system/out/sessions/ended" "${ENDED_LOG}" >/dev/null
sleep 1   # let the subscription settle

profile_id=$(harness::create_transcriber_profile "ended_durable_fake")

ended_count() { grep -cF "$1" "${ENDED_LOG}" || true; }

ended_notice() {
    harness::_compose exec -T database psql -U emeeting -d emeeting_test -tAc \
        "SELECT COALESCE(\"endedNotice\", 'NULL') FROM sessions WHERE id = '$1'"
}

# A session with a bot row on its channel, streaming over SRT: sets SESSION_ID,
# BOT_ID and STREAM_PID.
streaming_bot_session() {
    local channel_id bot
    SESSION_ID=$(harness::create_session "${profile_id}" "ended_durable_$1_$(date +%s)")
    harness::assert_status "${SESSION_ID}" "ready" 30 || fail "session should start ready"
    channel_id=$(harness::get_session "${SESSION_ID}" | jq -r '.channels[0].id')
    bot=$(harness::post "/bots" "$(jq -nc --argjson ch "${channel_id}" \
        '{url: "https://meet.example.com/ended-durable", channelId: $ch, provider: "visio", enableDisplaySub: false}')") \
        || fail "POST /bots failed"
    BOT_ID=$(jq -r '.id // empty' <<< "${bot}")
    [[ -n "${BOT_ID}" ]] || fail "could not read the bot id from: ${bot}"
    STREAM_PID=$(harness::stream_srt_loop "${SESSION_ID}" 0 "" 0)
    harness::assert_status "${SESSION_ID}" "active" 60 || fail "session did not become active"
}

bot_leaves() {
    mosquitto_pub -h "${HARNESS_MQTT_HOST}" -p "${HARNESS_MQTT_PORT}" -q 1 \
        -t "scheduler/in/schedule/stopbot" -m "{\"botId\": $1, \"endSession\": true}"
}

# ── A. Scheduler restart in the middle of the drain ─────────────────────────
harness::log "=== A: the Scheduler crashes while draining a bot session ==="
streaming_bot_session restart
session_a=${SESSION_ID}
bot_a=${BOT_ID}
harness::_compose pause transcriber >/dev/null   # the channel stays active: the drain lasts
bot_leaves "${bot_a}"
sleep 2
[[ "$(ended_notice "${session_a}")" == "pending" ]] || fail "endedNotice is '$(ended_notice "${session_a}")' during the drain, expected pending"
harness::ok "draining, sessions/ended owed (endedNotice=pending)"
harness::log "--- the Scheduler crashes mid-drain (SIGKILL), then starts again ---"
harness::_compose kill scheduler >/dev/null
harness::_compose start scheduler >/dev/null
harness::_compose unpause transcriber >/dev/null
deadline=$(( $(date +%s) + 60 ))
until [[ "$(ended_count "${session_a}")" -ge 1 ]]; do
    if [[ $(date +%s) -ge ${deadline} ]]; then
        harness::logs scheduler 80 || true
        fail "no sessions/ended for ${session_a} within 60s of the Scheduler restart"
    fi
    sleep 0.5
done
harness::scheduler_log_contains "Resuming the end of session\\(s\\) ${session_a}" \
    || fail "the restarted Scheduler did not resume the end"
sleep 5   # a duplicate would follow closely
[[ "$(ended_count "${session_a}")" -eq 1 ]] || fail "sessions/ended published $(ended_count "${session_a}") times, expected once"
[[ "$(ended_notice "${session_a}")" == "NULL" ]] || fail "endedNotice is '$(ended_notice "${session_a}")' after the publication, expected NULL"
harness::ok "sessions/ended published exactly once after the restart, marker cleared"
kill -9 "${STREAM_PID}" 2>/dev/null || true

# ── B. Studio's storing stop while the Scheduler drains ─────────────────────
harness::log "=== B: Studio takes the ending over during the drain (storing stop) ==="
streaming_bot_session takeover
session_b=${SESSION_ID}
bot_b=${BOT_ID}
harness::_compose pause transcriber >/dev/null
bot_leaves "${bot_b}"
sleep 1
# Studio's stopSessionAndFetch: the stop waits for the drain, so it runs aside.
harness::put "/sessions/${session_b}/stop?force=true&waitFinal=true" >/dev/null &
storing_stop=$!
sleep 1
[[ "$(ended_notice "${session_b}")" == "NULL" ]] || fail "endedNotice is '$(ended_notice "${session_b}")' after the storing stop, expected NULL"
harness::_compose unpause transcriber >/dev/null
wait "${storing_stop}" || fail "PUT /sessions/${session_b}/stop?waitFinal=true failed"
# The Scheduler's drain runs to its end (SESSION_STOP_FLUSH_TIMEOUT_MS, 10 s) before it checks the marker.
deadline=$(( $(date +%s) + 30 ))
until harness::scheduler_log_contains "Session ${session_b}: sessions/ended no longer owed"; do
    [[ $(date +%s) -lt ${deadline} ]] || { harness::logs scheduler 80 || true; fail "the Scheduler did not finish its drain within 30s"; }
    sleep 0.5
done
sleep 2
[[ "$(ended_count "${session_b}")" -eq 0 ]] || fail "the Scheduler published sessions/ended for a session Studio stopped"
harness::ok "no sessions/ended from the Scheduler: Studio took the ending over"
kill -9 "${STREAM_PID}" 2>/dev/null || true

# ── C. A plain stop while the Scheduler drains ──────────────────────────────
harness::log "=== C: a plain stop during the drain stores nothing: sessions/ended still goes out ==="
streaming_bot_session plainstop
session_c=${SESSION_ID}
bot_c=${BOT_ID}
harness::_compose pause transcriber >/dev/null
bot_leaves "${bot_c}"
sleep 1
harness::put "/sessions/${session_c}/stop?force=true" >/dev/null || fail "PUT /sessions/${session_c}/stop failed"
[[ "$(ended_notice "${session_c}")" != "NULL" ]] || fail "the plain stop cleared endedNotice"
harness::_compose unpause transcriber >/dev/null
deadline=$(( $(date +%s) + 30 ))
until [[ "$(ended_count "${session_c}")" -ge 1 ]]; do
    [[ $(date +%s) -lt ${deadline} ]] || { harness::logs scheduler 80 || true; fail "no sessions/ended for ${session_c} within 30s"; }
    sleep 0.5
done
sleep 3
[[ "$(ended_count "${session_c}")" -eq 1 ]] || fail "sessions/ended published $(ended_count "${session_c}") times, expected once"
[[ "$(ended_notice "${session_c}")" == "NULL" ]] || fail "endedNotice is '$(ended_notice "${session_c}")' after the publication, expected NULL"
harness::ok "the Scheduler's sessions/ended went out once despite the plain stop"
kill -9 "${STREAM_PID}" 2>/dev/null || true

harness::ok "session ended durable scenario PASSED"
