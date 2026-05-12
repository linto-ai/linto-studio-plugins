#!/usr/bin/env bash
# tests/integration/run.sh
#
# Orchestrator:
#   1. Bring the integration stack up and wait until healthy.
#   2. Run every executable file in tests/integration/scenarios/, in
#      lexicographic order.
#   3. Tear the stack down (volumes wiped) regardless of test outcome.
#   4. Exit non-zero if any scenario failed.
#
# Env:
#   KEEP_STACK=1   Don't tear the stack down on exit (useful for debugging).
#   ONLY=<glob>    Run only scenarios whose basename matches the glob.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=harness/lib.sh
source "${SCRIPT_DIR}/harness/lib.sh"

KEEP_STACK="${KEEP_STACK:-0}"
ONLY="${ONLY:-}"

cleanup() {
    if [[ "${KEEP_STACK}" != "1" ]]; then
        harness::down
    else
        harness::warn "KEEP_STACK=1 -> leaving the stack running"
        harness::_kill_bg
    fi
}
trap cleanup EXIT

harness::up || { harness::err "stack failed to come up"; exit 1; }

shopt -s nullglob
scenarios=("${SCRIPT_DIR}"/scenarios/*.sh)
shopt -u nullglob

if [[ ${#scenarios[@]} -eq 0 ]]; then
    harness::warn "no scenario found in ${SCRIPT_DIR}/scenarios/"
    exit 0
fi

# Sort scenarios deterministically.
IFS=$'\n' scenarios=($(printf '%s\n' "${scenarios[@]}" | sort))
unset IFS

failures=()

# Between scenarios, kill leftover client-side processes (streamers,
# subscribers) so that a misbehaving scenario does not pollute the next
# one's MQTT topics or saturate the transcriber with zombie streams.
#
# Each scenario installs `trap 'harness::_kill_bg' EXIT` (see helpers in
# lib.sh) which kills its own tracked PIDs on exit. This function is a
# belt-and-braces second pass for the case where a scenario was SIGKILLed
# or forked something detached. We scope every pkill pattern to harness-
# specific endpoints (project ports, the bundled ws-stream.js path) so we
# never kill an unrelated mosquitto_sub / ffmpeg / gst-launch the operator
# happens to be running on the same host.
between_scenarios_cleanup() {
    local helper="${SCRIPT_DIR}/harness/ws-stream.js"
    pkill -9 -f "gst-launch-1.0.*srtsink.*:${HARNESS_SRT_PORT}" 2>/dev/null || true
    pkill -9 -f "ffmpeg.*sine=frequency=440:sample_rate=16000" 2>/dev/null || true
    pkill -9 -f "ffmpeg.*rtmp://[^ ]*:${HARNESS_RTMP_PORT}" 2>/dev/null || true
    pkill -9 -f "mosquitto_sub.*-p ${HARNESS_MQTT_PORT}" 2>/dev/null || true
    pkill -9 -f "node ${helper}" 2>/dev/null || true
    # Drop terminated sessions so retained snapshots stay slim
    # (the DB cleanup runs inside each scenario via DELETE; this is a
    # belt-and-braces measure for cases where a scenario crashed midway).
    sleep 1
}

for s in "${scenarios[@]}"; do
    name=$(basename "${s}")
    if [[ -n "${ONLY}" ]]; then
        # shellcheck disable=SC2053
        [[ "${name}" == ${ONLY} ]] || { harness::log "skipping ${name} (filtered by ONLY=${ONLY})"; continue; }
    fi
    harness::log "----- running ${name} -----"
    if bash "${s}"; then
        harness::ok "${name} passed"
    else
        harness::err "${name} FAILED"
        failures+=("${name}")
    fi
    between_scenarios_cleanup
done

if [[ ${#failures[@]} -gt 0 ]]; then
    harness::err "${#failures[@]} scenario(s) failed: ${failures[*]}"
    exit 1
fi

harness::ok "all scenarios passed"
exit 0
