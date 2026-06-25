#!/usr/bin/env bash
# tests/integration/scenarios/21-bot-distribution.sh
#
# Exercises the Scheduler's bot LOAD-BALANCING across multiple BotService
# replicas, end to end over the real control plane (Session-API -> MQTT ->
# Scheduler), with NO browsers and NO real meetings.
#
# Why no browsers: the thing under test is the Scheduler's *routing decision* —
# which BotService replica a new bot is assigned to — not the bot capture itself
# (that's scenario 19). The decision is driven entirely by the retained presence
# each replica publishes on `botservice/out/<uniqueId>/status`
# ({uniqueId, online, activeBots, capabilities, rss}) and consumed by the real
# Scheduler. So we SIMULATE several replicas by publishing that exact presence
# contract, create real bots through the real Session-API POST /bots path, and
# observe which `botservice/in/<uniqueId>/startbot` the Scheduler emits.
#
# Topology registered (retained presence):
#   VISIO1  caps=[visio]         activeBots=3   (visio specialist)
#   VISIO2  caps=[visio]         activeBots=1   (visio specialist, less loaded)
#   TEAMS1  caps=[teams]         activeBots=0   (teams specialist, idle)
#   GEN1    caps=[visio,teams]   activeBots=0   (generalist, idle)
#
# Sequence + what each step proves about selectBotService():
#   #1 visio -> VISIO2  : capability filter (TEAMS1 is idlest but can't do visio)
#                         + specialist preference (GEN1 is idle but a generalist)
#                         + least-loaded among specialists (1 < 3)
#   #2 visio -> VISIO1  : after VISIO2 is bumped to 5, the next visio bot moves to
#                         the now-least-loaded specialist (3 < 5) — real rebalancing
#   #3 teams -> TEAMS1  : provider-specific routing (teams specialist beats GEN1)
#   #4 visio -> GEN1    : both visio specialists go overloaded (advertise caps=[]),
#                         so the generalist takes over (backpressure failover)
#
# CI-safe: pure control-plane (broker + Session-API + Scheduler + DB, all already
# in the integration stack) and the host mosquitto clients. No cloud keys, no
# Chromium.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../harness/lib.sh
source "${SCRIPT_DIR}/../harness/lib.sh"

harness::install_cleanup_trap

fail() { harness::err "FAIL: $*"; exit 1; }

# Unique replica ids for this run (so retained presence never collides with a
# previous run still lingering on the broker).
RUN="$(date +%s)"
VISIO1="botservice-visio1-${RUN}"
VISIO2="botservice-visio2-${RUN}"
TEAMS1="botservice-teams1-${RUN}"
GEN1="botservice-gen1-${RUN}"

# publish_presence UNIQUEID CAPS_JSON ACTIVEBOTS
# Publishes the retained BotService presence the Scheduler consumes. CAPS_JSON is
# a JSON array literal, e.g. '["visio"]' or '[]' (overloaded/backpressure).
publish_presence() {
    local uid="$1" caps="$2" active="$3"
    local payload
    payload=$(jq -nc --arg uid "${uid}" --argjson caps "${caps}" --argjson active "${active}" \
        '{uniqueId: $uid, online: true, activeBots: $active, capabilities: $caps, rss: 104857600}')
    mosquitto_pub -h "${HARNESS_MQTT_HOST}" -p "${HARNESS_MQTT_PORT}" \
        -t "botservice/out/${uid}/status" -m "${payload}" -q 1 -r
}

# unregister_presence UNIQUEID — mark the replica offline (the real disconnect
# contract: a valid {online:false} retained message, NOT an empty payload — the
# Scheduler JSON.parse()s every status message, so an empty body would poison it).
unregister_presence() {
    local uid="$1"
    mosquitto_pub -h "${HARNESS_MQTT_HOST}" -p "${HARNESS_MQTT_PORT}" \
        -t "botservice/out/${uid}/status" \
        -m "$(jq -nc --arg uid "${uid}" '{uniqueId: $uid, online: false}')" -q 1 -r 2>/dev/null || true
}

# create_bot CHANNELID PROVIDER -> prints the created bot id
create_bot() {
    local channel_id="$1" provider="$2"
    local body resp id
    body=$(jq -nc --arg url "https://meet.example.com/room-${RUN}-${channel_id}" \
        --argjson ch "${channel_id}" --arg prov "${provider}" \
        '{url: $url, channelId: $ch, provider: $prov, enableDisplaySub: false}')
    resp=$(harness::post "/bots" "${body}") || { harness::err "POST /bots failed: ${resp:-}"; return 1; }
    id=$(jq -r '.id // empty' <<< "${resp}")
    [[ -n "${id}" ]] || { harness::err "no bot id in POST /bots response: ${resp}"; return 1; }
    echo "${id}"
}

# expect_routed STARTBOT_LOG BOTID EXPECTED_UNIQUEID [TIMEOUT]
# Waits for a startbot command carrying BOTID and asserts it was published to the
# EXPECTED_UNIQUEID's inbox (botservice/in/<uniqueId>/startbot). Also asserts no
# OTHER replica received the same bot.
expect_routed() {
    local log="$1" bot_id="$2" expected="$3" timeout="${4:-20}"
    local deadline=$(( $(date +%s) + timeout ))
    local line=""
    while :; do
        # mosquitto_sub -v lines are "<topic> <json>"; match this bot exactly.
        line=$(grep -E "\"botId\":${bot_id}([,}])" "${log}" 2>/dev/null | head -1 || true)
        [[ -n "${line}" ]] && break
        if [[ $(date +%s) -ge ${deadline} ]]; then
            harness::err "bot ${bot_id} was never routed within ${timeout}s. startbot log:"
            cat "${log}" >&2 || true
            return 1
        fi
        sleep 0.5
    done
    local topic uid
    topic=$(awk '{print $1}' <<< "${line}")
    uid=$(cut -d/ -f3 <<< "${topic}")
    if [[ "${uid}" != "${expected}" ]]; then
        harness::err "bot ${bot_id} routed to ${uid}, expected ${expected}"
        return 1
    fi
    harness::ok "bot ${bot_id} routed to ${expected} (as expected)"
}

# ── Setup: profile + a session with 4 inactive channels (one per bot) ──────────
harness::log "=== scenario 21: bot distribution across BotService replicas ==="

profile_id=$(harness::create_transcriber_profile "fake_botdist_${RUN}") \
    || fail "could not create transcriber profile"
session_id=$(harness::create_session_multi "${profile_id}" 4 "it_botdist_${RUN}") \
    || fail "could not create 4-channel session"
session_json=$(harness::get_session "${session_id}")
mapfile -t CH < <(jq -r '.channels[].id' <<< "${session_json}")
[[ ${#CH[@]} -ge 4 ]] || fail "expected 4 channels, got ${#CH[@]}"
harness::log "session ${session_id} channels: ${CH[*]}"

# Capture every startbot the Scheduler emits, for any replica.
STARTBOT_LOG=$(mktemp)
harness::mqtt_subscribe "botservice/in/+/startbot" "${STARTBOT_LOG}" >/dev/null

# Register our topology (uniqueIds are per-run, so no stale-presence collision).
publish_presence "${VISIO1}" '["visio"]'          3
publish_presence "${VISIO2}" '["visio"]'          1
publish_presence "${TEAMS1}" '["teams"]'          0
publish_presence "${GEN1}"   '["visio","teams"]'  0
sleep 3   # let the Scheduler ingest the four presence messages

rc=0

# ── #1 visio: capability filter + specialist preference + least loaded ─────────
b1=$(create_bot "${CH[0]}" "visio") || fail "create bot #1"
expect_routed "${STARTBOT_LOG}" "${b1}" "${VISIO2}" || rc=1

# ── #2 visio: rebalance after the chosen specialist gets loaded ────────────────
publish_presence "${VISIO2}" '["visio"]' 5
sleep 2
b2=$(create_bot "${CH[1]}" "visio") || fail "create bot #2"
expect_routed "${STARTBOT_LOG}" "${b2}" "${VISIO1}" || rc=1

# ── #3 teams: provider-specific routing (specialist beats generalist) ──────────
b3=$(create_bot "${CH[2]}" "teams") || fail "create bot #3"
expect_routed "${STARTBOT_LOG}" "${b3}" "${TEAMS1}" || rc=1

# ── #4 visio: both visio specialists overloaded -> generalist failover ─────────
publish_presence "${VISIO1}" '[]' 3   # advertise no capabilities (backpressure)
publish_presence "${VISIO2}" '[]' 5
sleep 2
b4=$(create_bot "${CH[3]}" "visio") || fail "create bot #4"
expect_routed "${STARTBOT_LOG}" "${b4}" "${GEN1}" || rc=1

# ── Cleanup: mark our fake replicas offline so they don't leak into later runs ─
for uid in "${VISIO1}" "${VISIO2}" "${TEAMS1}" "${GEN1}"; do unregister_presence "${uid}"; done
rm -f "${STARTBOT_LOG}"

if [[ ${rc} -ne 0 ]]; then
    fail "bot distribution did not route as expected (see above)"
fi
harness::ok "scenario 21 passed (bots distributed to the correct/least-loaded BotService)"
exit 0
