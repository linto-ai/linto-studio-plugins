#!/usr/bin/env bash
# tests/integration/scenarios/13-pause-resume-linto.sh
#
# End-to-end validation of the pause/resume feature against a REAL LinTO ASR
# backend. This is the LinTO counterpart of 06-pause-resume-microsoft.sh: it
# proves that the `provider.stop()` -> `provider.start()` cycle of
# LintoTranscriber (see Transcriber/ASR/linto/index.js) holds against a live
# LinTO WebSocket endpoint.
#
# Requirements:
#   - LINTO_ENDPOINT: WebSocket URL of a reachable LinTO ASR instance
#     (e.g. wss://linto.example.com/transcribe)
#   - LINTO_LANG (optional): BCP47 candidate, defaults to fr-FR
#
# If LINTO_ENDPOINT is missing, the scenario emits a warning and exits 0
# (skipped, not failed) so CI without a LinTO backend still passes.
#
# What we assert:
#   - A LinTO profile is accepted by Session-API (languages[i].endpoint is the
#     LinTO-specific shape — see transcriber_profiles route validation)
#   - A session backed by that profile reaches `active` once audio flows
#   - The Transcriber logs "Starting linto ASR" (emitted by ASR/index.js
#     start() at info level — the only info-level marker tied to provider
#     start in the Linto path, since LintoTranscriber's "WebSocket connection
#     established" log is debug-only and the test compose runs LOG_LEVEL=info)
#   - PUT /sessions/:id/pause flips status to `paused`, emits
#     system/out/sessions/paused, and silences transcription topics
#   - PUT /sessions/:id/resume flips status back to `active` AND the
#     Transcriber logs a SECOND "Starting linto ASR" line — proof that
#     provider.start() was invoked again (i.e. the stop/start cycle ran)
#
# Why we lean on container logs rather than partial/final MQTT messages:
# the SRT stream we send is a 440Hz sine wave (audiotestsrc) — LinTO will not
# emit transcriptions for a pure tone, so MQTT silence on the partial topic is
# not a reliable signal that the WebSocket connection succeeded or failed.
# The "Starting linto ASR" log is deterministic: it fires once per call to
# ASR.start() regardless of whether the upstream WS later transcribes.

set -uo pipefail

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

# ---------------------------------------------------------------------------
# Gate on LinTO endpoint. Skip cleanly if missing.
# ---------------------------------------------------------------------------
if [[ -z "${LINTO_ENDPOINT:-}" ]]; then
    harness::warn "skipping: LINTO_ENDPOINT env var required (e.g. wss://linto.example.com/transcribe)"
    exit 0
fi

LINTO_LANG="${LINTO_LANG:-fr-FR}"

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

# Count occurrences of a substring in the recent transcriber logs.
# Args: NEEDLE [TAIL_LINES]
count_in_transcriber_logs() {
    local needle="$1"
    local tail_n="${2:-500}"
    harness::_compose logs --tail="${tail_n}" --no-color transcriber 2>/dev/null \
        | grep -cF -- "${needle}" || true
}

# Wait until the cumulative count of NEEDLE in transcriber logs is >= MIN.
# Args: NEEDLE MIN_COUNT TIMEOUT
wait_for_log_count() {
    local needle="$1"
    local min="$2"
    local timeout="${3:-30}"
    local deadline=$(( $(date +%s) + timeout ))
    local got=0
    while :; do
        got=$(count_in_transcriber_logs "${needle}" 1000)
        if [[ "${got}" -ge "${min}" ]]; then
            harness::ok "transcriber logs contain ${got} occurrence(s) of '${needle}' (>= ${min})"
            return 0
        fi
        if [[ $(date +%s) -ge ${deadline} ]]; then
            harness::err "transcriber logs only contain ${got} occurrence(s) of '${needle}' (expected >= ${min})"
            return 1
        fi
        sleep 1
    done
}

# ---------------------------------------------------------------------------
# Bring the stack up only if needed. The default docker-compose.test.yml
# leaves ASR_PROVIDER=fake, but the Transcriber selects the provider per
# channel via channel.transcriberProfile.config.type (see Transcriber/ASR/
# index.js loadAsr()), so a "linto" profile drives the LinTO backend
# regardless of the env default.
# ---------------------------------------------------------------------------
if ! harness::_compose ps --status running --services 2>/dev/null | grep -q '^sessionapi$'; then
    harness::log "stack not running, bringing it up"
    harness::up || { harness::err "stack failed to come up"; exit 1; }
fi

harness::log "=== pause/resume scenario (LinTO ASR) ==="

# ---------------------------------------------------------------------------
# Setup: create a LinTO profile + a session bound to it.
# ---------------------------------------------------------------------------
profile_id=$(harness::create_linto_profile \
    "pause_resume_linto_$(date +%s)" \
    "${LINTO_ENDPOINT}" \
    "${LINTO_LANG}")
harness::ok "created LinTO transcriber profile id=${profile_id}"

session_id=$(harness::create_session "${profile_id}" "pr_linto_$(date +%s)")
harness::ok "created session id=${session_id}"

harness::assert_status "${session_id}" "ready" 30 \
    || fail "initial session status should be ready"

# ---------------------------------------------------------------------------
# Subscribe to MQTT events early so we don't miss them.
# ---------------------------------------------------------------------------
PAUSED_LOG=$(mktemp)
RESUMED_LOG=$(mktemp)
PARTIAL_LOG=$(mktemp)
FINAL_LOG=$(mktemp)

harness::mqtt_subscribe "system/out/sessions/paused"  "${PAUSED_LOG}"  >/dev/null
harness::mqtt_subscribe "system/out/sessions/resumed" "${RESUMED_LOG}" >/dev/null
harness::mqtt_subscribe "transcriber/out/${session_id}/+/partial" "${PARTIAL_LOG}" >/dev/null
harness::mqtt_subscribe "transcriber/out/${session_id}/+/final"   "${FINAL_LOG}"   >/dev/null
sleep 1  # let subscriptions settle

cleanup_logs() {
    rm -f "${PAUSED_LOG}" "${RESUMED_LOG}" "${PARTIAL_LOG}" "${FINAL_LOG}"
}
trap 'cleanup_logs; harness::_kill_bg' EXIT

# Marker used to count LinTO provider start invocations. ASR/index.js start()
# logs `Starting linto ASR` at info level immediately before instantiating
# LintoTranscriber and awaiting provider.start(). Each call to ASR.start()
# (initial start + resume) produces exactly one line.
READY_MARKER="Starting linto ASR"

# Snapshot how many lines already exist (other tests, leftovers...) so we
# count only NEW ones produced by this scenario.
baseline_ready=$(count_in_transcriber_logs "${READY_MARKER}" 1000)
harness::log "baseline '${READY_MARKER}' count in transcriber logs: ${baseline_ready}"

# ---------------------------------------------------------------------------
# Start streaming so the session transitions to active.
# A 440Hz sine on SRT is enough to drive the audio pipeline; LinTO will
# accept the WebSocket connection even if it does not emit any transcription.
# ---------------------------------------------------------------------------
harness::log "--- starting SRT loop stream towards ${session_id} ---"
stream_pid=$(harness::stream_srt_loop "${session_id}" 0 "${AUDIO}" 0)
harness::log "SRT stream pid=${stream_pid}"

if ! wait_for_status "${session_id}" "active" 60 >/dev/null; then
    harness::logs sessionapi 50 || true
    harness::logs scheduler 50 || true
    harness::logs transcriber 100 || true
    fail "session did not become 'active' within 60s of streaming"
fi
harness::ok "session is active"

# Wait until the Transcriber reports its first LinTO provider start. This is
# what tells us the linto code path was really exercised (vs. the fake
# provider) — provider.start() will then open the WebSocket to LINTO_ENDPOINT.
if ! wait_for_log_count "${READY_MARKER}" "$((baseline_ready + 1))" 30; then
    harness::logs transcriber 150 || true
    fail "LinTO ASR start log not seen within 30s — check endpoint/network"
fi
ready_after_start=$(count_in_transcriber_logs "${READY_MARKER}" 1000)
harness::ok "LinTO ASR start observed (count went ${baseline_ready} -> ${ready_after_start})"

# ---------------------------------------------------------------------------
# Pause the active session.
# ---------------------------------------------------------------------------
harness::log "--- pausing session ---"
harness::http PUT "/sessions/${session_id}/pause" >/dev/null \
    || fail "PUT /pause on active session failed"
harness::assert_status "${session_id}" "paused" 15 \
    || fail "session did not transition to 'paused'"

# The SRT stream must stay alive across pause.
if ! kill -0 "${stream_pid}" 2>/dev/null; then
    fail "SRT stream pid=${stream_pid} died during pause; the stream MUST stay open"
fi
harness::ok "SRT stream still running after pause"

# LinTO may take a beat to flush any in-flight partial; use a generous silence
# window to avoid flakiness on slow networks.
harness::mqtt_assert_silent "transcriber/out/${session_id}/+/partial" 15 \
    || fail "transcriber kept emitting partials after pause"

# Pause MQTT event must have been published.
sleep 2
if ! grep -q "${session_id}" "${PAUSED_LOG}"; then
    harness::err "expected session id ${session_id} in paused log; content:"
    cat "${PAUSED_LOG}" >&2 || true
    fail "system/out/sessions/paused was not emitted"
fi
harness::ok "system/out/sessions/paused contains ${session_id}"

# ---------------------------------------------------------------------------
# Resume the session: this is the assertion that matters most for this
# scenario. provider.start() must rebuild the LinTO WebSocket from scratch.
# ---------------------------------------------------------------------------
harness::log "--- resuming session ---"
harness::http PUT "/sessions/${session_id}/resume" >/dev/null \
    || fail "PUT /resume failed"
harness::assert_status "${session_id}" "active" 15 \
    || fail "session did not transition back to 'active'"

# Expect a SECOND "Starting linto ASR" line (one more than after initial start).
if ! wait_for_log_count "${READY_MARKER}" "$((ready_after_start + 1))" 45; then
    harness::logs transcriber 200 || true
    fail "LinTO ASR did not re-start after resume — provider.start() likely broken"
fi
harness::ok "LinTO ASR re-started successfully after resume"

# Resume MQTT event must have been published.
sleep 2
if ! grep -q "${session_id}" "${RESUMED_LOG}"; then
    harness::err "expected session id ${session_id} in resumed log; content:"
    cat "${RESUMED_LOG}" >&2 || true
    fail "system/out/sessions/resumed was not emitted"
fi
harness::ok "system/out/sessions/resumed contains ${session_id}"

# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------
kill "${stream_pid}" 2>/dev/null || true
harness::http DELETE "/sessions/${session_id}?force=true" >/dev/null 2>&1 || true
harness::http DELETE "/transcriber_profiles/${profile_id}" >/dev/null 2>&1 || true

harness::ok "LinTO pause/resume scenario PASSED"
