#!/usr/bin/env bash
# tests/integration/scenarios/18-bot-native-diarization.sh
#
# Validates the decoupled-bot native-diarization ingest path on the Transcriber.
# A real BotService would join a meeting in a headless browser; here we simulate
# its WIRE BEHAVIOUR with ws-stream-bot.js — it opens the session in
# diarizationMode='native', announces participants, streams PCM and interleaves
# speakerChanged events, exactly as the BotService's TranscriberStream does.
#
# Part A (always, FAKE asr, no secrets):
#   - a native-diarization WS stream is accepted and the session goes active
#   - the Transcriber logs "Native diarization enabled" (init{native} processed,
#     SpeakerTracker created) — i.e. the control-message path did not break ingest
#
# Part B (only with AZURE_SPEECH_KEY/REGION): a real Microsoft ASR run with two
# alternating speakers produces closedCaptions whose `locutor` is populated from
# the bot-provided speaker names (native diarization end-to-end). Skipped cleanly
# when no Azure secret is present, so CI without secrets still passes.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../harness/lib.sh
source "${SCRIPT_DIR}/../harness/lib.sh"

harness::install_cleanup_trap

FIXTURES_DIR="${SCRIPT_DIR}/../fixtures"
AUDIO="${FIXTURES_DIR}/audio.wav"
SPEECH="${FIXTURES_DIR}/speech-en.wav"

fail() { harness::err "FAIL: $*"; exit 1; }

# Stream PCM via the native-diarization bot helper (init{native} + participants +
# alternating speakerChanged). Mirrors harness::stream_ws but uses ws-stream-bot.js.
stream_ws_bot() {
    local session_id="$1" channel_index="${2:-0}" audio="$3" participants="${4:-u1:Alice,u2:Bob}"
    local helper="${HARNESS_LIB_DIR}/ws-stream-bot.js"
    local url="ws://${HARNESS_WS_HOST}:${HARNESS_WS_PORT}/${HARNESS_WS_ENDPOINT}/${session_id},${channel_index}"
    harness::log "stream_ws_bot: ${audio} -> ${url}"
    ( ffmpeg -hide_banner -loglevel error -re -i "${audio}" -ar 16000 -ac 1 -f s16le pipe:1 \
        | node "${helper}" "${url}" "${participants}" 1200 ) >/dev/null 2>&1 &
    local pid=$!
    harness::_track_bg "${pid}"
    echo "${pid}"
}

if ! harness::_compose ps --status running --services 2>/dev/null | grep -q '^sessionapi$'; then
    harness::log "stack not running, bringing it up"
    harness::up || { harness::err "stack failed to come up"; exit 1; }
fi

# ── Part A — native ingest smoke (FAKE asr) ─────────────────────────────────
harness::log "=== Part A: native-diarization ingest (fake ASR) ==="
profile_id=$(harness::create_transcriber_profile "bot_native_fake")
session_id=$(harness::create_session "${profile_id}" "bot_native_$(date +%s)")
harness::assert_status "${session_id}" "ready" 30 || fail "session should start ready"

stream_pid=$(stream_ws_bot "${session_id}" 0 "${AUDIO}" "u1:Alice,u2:Bob")
harness::assert_status "${session_id}" "active" 30 \
    || fail "session should become active once the native-diarization stream connects"

# The init{diarizationMode:native} must have created a SpeakerTracker.
deadline=$(( $(date +%s) + 15 ))
found=0
while [[ $(date +%s) -lt ${deadline} ]]; do
    if harness::logs transcriber 400 2>/dev/null | grep -q "Native diarization enabled"; then found=1; break; fi
    sleep 1
done
[[ "${found}" -eq 1 ]] || fail "transcriber did not log 'Native diarization enabled' (control path broke ingest)"
harness::ok "native-diarization ingest accepted; session active; SpeakerTracker created"

kill "${stream_pid}" 2>/dev/null || true
harness::stop_session "${session_id}" || true

# ── Part B — locutor on captions (REAL Microsoft asr, gated) ────────────────
if [[ -z "${AZURE_SPEECH_KEY:-}" || -z "${AZURE_SPEECH_REGION:-}" ]]; then
    harness::warn "Part B skipped: AZURE_SPEECH_KEY and AZURE_SPEECH_REGION required for the real-ASR locutor assertion"
    harness::ok "scenario 18 passed (Part A)"
    exit 0
fi

harness::log "=== Part B: native-diarization locutor on captions (Microsoft ASR) ==="
ms_profile=$(harness::create_microsoft_profile "bot_native_ms" "${AZURE_SPEECH_KEY}" "${AZURE_SPEECH_REGION}" "en-US")
ms_session=$(harness::create_session "${ms_profile}" "bot_native_ms_$(date +%s)")
harness::assert_status "${ms_session}" "ready" 30 || fail "MS session should start ready"

ms_pid=$(stream_ws_bot "${ms_session}" 0 "${SPEECH}" "u1:Alice,u2:Bob")
harness::assert_status "${ms_session}" "active" 60 || fail "MS session should become active"
# Let the speech transcribe with alternating speakers, then stop to flush finals.
sleep 25
kill "${ms_pid}" 2>/dev/null || true
harness::stop_session "${ms_session}" || true
sleep 5

result=$(harness::get "/sessions/${ms_session}?withCaptions=true")
closed_count=$(jq -r '.channels[0].closedCaptions | length' <<< "${result}")
[[ "${closed_count}" -gt 0 ]] || fail "closedCaptions is empty (no transcription produced)"
locutor_count=$(jq -r '[.channels[0].closedCaptions[] | select(.locutor != null and (.locutor | tostring | length) > 0)] | length' <<< "${result}")
[[ "${locutor_count}" -gt 0 ]] || fail "no caption carries a native-diarization locutor"
harness::ok "captions=${closed_count}, with locutor=${locutor_count} (native diarization end-to-end)"
harness::ok "scenario 18 passed (Part A + B)"
