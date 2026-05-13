#!/usr/bin/env bash
# tests/integration/harness/test-cleanup-scoped.sh
#
# Standalone behavior test for harness::between_scenarios_cleanup.
#
# The cleanup function in lib.sh runs `pkill -9 -f PATTERN` against several
# patterns. The patch that introduced this test scoped each pattern to a
# harness-specific endpoint (project ports, the bundled ws-stream.js path)
# precisely because the previous broad form (`pkill -9 -f mosquitto_sub`)
# would kill any unrelated mosquitto_sub the operator was running on the
# same host.
#
# This test spawns fake processes whose argv[0] mimics the bare command
# names matched by the BROAD patterns but does NOT include the harness-
# specific tokens, then runs the cleanup and asserts they survive.
# It also spawns processes whose cmdline DOES include the harness tokens
# and asserts they are killed — so we verify both sides of the contract.
#
# Requires: bash, ps, kill, pkill, sleep. No Docker.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

# Track every pid we spawn so the EXIT trap kills them even on failure.
declare -a TEST_PIDS=()

cleanup() {
    local pid
    for pid in "${TEST_PIDS[@]:-}"; do
        kill -9 "${pid}" 2>/dev/null || true
    done
}
trap cleanup EXIT

# Spawn a process whose argv[0] is exactly the given string so /proc/PID/cmdline
# matches it for `pkill -f`. exec -a sets argv[0] without changing what's run.
# stdout/stderr are detached from the parent: callers use `pid=$(spawn_fake)`
# in command substitution which would otherwise wait for the bg subshell to
# close its stdout (i.e. for sleep to finish). NOTE: callers must `track_pid`
# the returned PID — TEST_PIDS modifications inside this function would be
# lost across the command-substitution subshell.
spawn_fake() {
    local fake_argv0="$1"
    (exec -a "${fake_argv0}" sleep 60) >/dev/null 2>&1 &
    echo "$!"
}

track_pid() {
    TEST_PIDS+=("$1")
}

assert_alive() {
    local pid="$1"
    local label="$2"
    if ! kill -0 "${pid}" 2>/dev/null; then
        echo "FAIL: ${label} (pid=${pid}) was killed by harness::between_scenarios_cleanup but should have survived" >&2
        exit 1
    fi
    echo "  alive  : ${label} (pid=${pid})"
}

assert_dead() {
    local pid="$1"
    local label="$2"
    # Give pkill a brief moment to deliver SIGKILL.
    local i
    for i in 1 2 3 4 5; do
        kill -0 "${pid}" 2>/dev/null || { echo "  killed : ${label} (pid=${pid})"; return 0; }
        sleep 0.1
    done
    echo "FAIL: ${label} (pid=${pid}) was NOT killed by harness::between_scenarios_cleanup but should have been" >&2
    exit 1
}

echo "=== test-cleanup-scoped: harness::between_scenarios_cleanup ==="
echo "Using HARNESS_SRT_PORT=${HARNESS_SRT_PORT}, HARNESS_RTMP_PORT=${HARNESS_RTMP_PORT}, HARNESS_MQTT_PORT=${HARNESS_MQTT_PORT}"

# ---- Foreign processes (must SURVIVE) -------------------------------------
# A bare gst-launch-1.0 with no srtsink and no harness port — the previous
# broad pattern `gst-launch-1.0` would have killed it; the scoped pattern
# `gst-launch-1.0.*srtsink.*:${HARNESS_SRT_PORT}` must not.
foreign_gst=$(spawn_fake "gst-launch-1.0 -q audiotestsrc dummy"); track_pid "${foreign_gst}"

# A foreign mosquitto_sub on the standard port 1883 (not the harness's 1884).
foreign_mosq=$(spawn_fake "mosquitto_sub -h example.com -p 1883 -t /demo/topic"); track_pid "${foreign_mosq}"

# A foreign ffmpeg with no lavfi sine and no harness rtmp port.
foreign_ffmpeg=$(spawn_fake "ffmpeg -i input.mp4 -c:v copy output.mp4"); track_pid "${foreign_ffmpeg}"

# A foreign mosquitto_sub bound to a DIFFERENT port that doesn't even use -p
# (defaults to 1883). Just to be thorough.
foreign_mosq_default=$(spawn_fake "mosquitto_sub -h broker.local -t /a/b"); track_pid "${foreign_mosq_default}"

# ---- Target processes (must be KILLED) ------------------------------------
# A gst-launch-1.0 line that mimics what harness::stream_srt_loop produces.
target_gst=$(spawn_fake "gst-launch-1.0 -q audiotestsrc is-live=true ! srtsink uri=srt://h:${HARNESS_SRT_PORT}?streamid=test"); track_pid "${target_gst}"

# A mosquitto_sub explicitly bound to the harness port.
target_mosq=$(spawn_fake "mosquitto_sub -h harness -p ${HARNESS_MQTT_PORT} -t /system/out/sessions/paused"); track_pid "${target_mosq}"

# An ffmpeg with the exact lavfi sine pattern the harness uses.
target_ffmpeg_sine=$(spawn_fake "ffmpeg -re -f lavfi -i sine=frequency=440:sample_rate=16000:duration=0 -ar 16000"); track_pid "${target_ffmpeg_sine}"

# An ffmpeg targeting the harness rtmp port.
target_ffmpeg_rtmp=$(spawn_fake "ffmpeg -re -i input.wav -c:a aac -f flv rtmp://h:${HARNESS_RTMP_PORT}/sess/0"); track_pid "${target_ffmpeg_rtmp}"

# Let the OS settle — exec -a + & may take a few ms before /proc/PID/cmdline
# is fully populated.
sleep 0.3

echo "Spawned ${#TEST_PIDS[@]} fake processes"

# ---- Run the cleanup -----------------------------------------------------
echo "=== running harness::between_scenarios_cleanup ==="
harness::between_scenarios_cleanup

# ---- Assertions ----------------------------------------------------------
echo "=== verifying survivors ==="
assert_alive "${foreign_gst}"          'foreign gst-launch-1.0 (no srtsink, no harness port)'
assert_alive "${foreign_mosq}"         'foreign mosquitto_sub on port 1883'
assert_alive "${foreign_mosq_default}" 'foreign mosquitto_sub with no -p arg'
assert_alive "${foreign_ffmpeg}"       'foreign ffmpeg without lavfi/harness rtmp port'

echo "=== verifying targets were killed ==="
assert_dead  "${target_gst}"           'harness gst-launch-1.0 (srtsink + HARNESS_SRT_PORT)'
assert_dead  "${target_mosq}"          'harness mosquitto_sub (-p HARNESS_MQTT_PORT)'
assert_dead  "${target_ffmpeg_sine}"   'harness ffmpeg lavfi sine'
assert_dead  "${target_ffmpeg_rtmp}"   'harness ffmpeg rtmp on HARNESS_RTMP_PORT'

echo "=== PASS ==="
