#!/usr/bin/env bash
# tests/integration/scenarios/17-diarization-translation-microsoft.sh
#
# End-to-end regression lock for the "saved transcription empty when speaker
# detection AND translation are both enabled" bug (fixed on branch
# fix/dual-recognizer-diar-translation, commit
# "[Transcriber] Fix diarization+translation dual recognizer producing empty
# saved transcript").
#
# Root cause recap: in Microsoft dual mode (diarization + translation), the
# primary recognizer must be a ConversationTranscriber (so result.speakerId ->
# caption.locutor is populated) and the secondary a TranslationRecognizer. The
# bug built the primary as a TranslationRecognizer instead, so every segment had
# locutor=undefined and, with diarization on, studio-api dropped all canonical
# turns -> empty saved transcript. The fix also replaced a fragile modulo-2
# counter with explicit origin-tagging (isPrimary) so exactly one caption line is
# saved per segmentId while the secondary still contributes translations.
#
# This scenario drives a REAL Microsoft Azure Speech backend (same gating model
# as 06-pause-resume-microsoft.sh) and asserts, via the Session-API HTTP read
# path only (no direct DB access — the harness has none):
#   Fix A  : at least one closedCaption has a non-empty `locutor`
#            => the primary really is a ConversationTranscriber.
#   Origin : #closedCaptions == #distinct segmentId
#            => no duplicate canonical line per segment (origin-tagging works,
#               the secondary's translation-only finals never became captions).
#   Secondary: translatedCaptions contains entries for target `de`
#            => the TranslationRecognizer ran and its translations were persisted.
#
# Captions/translations are persisted by the Scheduler's BrokerClient
# (Scheduler/components/BrokerClient/index.js saveTranscription/saveTranslation),
# which subscribes to transcriber/out/+/+/final and .../final/translations. So
# GET /sessions/<id>?withCaptions reflects exactly what the dual recognizer
# emitted on MQTT.
#
# Requirements:
#   - AZURE_SPEECH_KEY: Azure Cognitive Services Speech subscription key
#   - AZURE_SPEECH_REGION: Azure region (e.g. westeurope)
#
# If either env var is missing the scenario warns and exits 0 (skipped, not
# failed) so CI without secrets stays green. The gate is the FIRST thing we do,
# before any stack requirement (mirrors 06).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../harness/lib.sh
source "${SCRIPT_DIR}/../harness/lib.sh"

# ---------------------------------------------------------------------------
# Gate on Azure credentials FIRST. Skip cleanly if either is missing, before we
# require (or bring up) the stack — so a credential-less CI run is a no-op exit 0.
# ---------------------------------------------------------------------------
if [[ -z "${AZURE_SPEECH_KEY:-}" || -z "${AZURE_SPEECH_REGION:-}" ]]; then
    harness::warn "skipping: AZURE_SPEECH_KEY and AZURE_SPEECH_REGION required"
    exit 0
fi

harness::install_cleanup_trap

FIXTURES_DIR="${SCRIPT_DIR}/../fixtures"
# Real speech (not a sine tone): Azure only emits finals with speakerId +
# translations for actual words. speech-en.wav is a ~10s 16kHz mono PCM clip
# derived from the repo's en.mp3 (see fixtures/README.md for provenance).
SPEECH_AUDIO="${FIXTURES_DIR}/speech-en.wav"

# Target language for discrete translation. German has no Azure regional-variant
# collision risk, so a single bare "de" is unambiguous (see translationHelpers.js
# COLLISION_RISK_PRIMARIES).
TARGET_LANG="de"

fail() {
    harness::err "FAIL: $*"
    exit 1
}

if [[ ! -f "${SPEECH_AUDIO}" ]]; then
    fail "speech fixture not found: ${SPEECH_AUDIO}"
fi

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

# Wait until OUTPUT_FILE (an mqtt_subscribe sink) contains a non-empty line, or
# TIMEOUT elapses. Returns 0/1.
# Args: FILE LABEL [TIMEOUT]
wait_for_nonempty_log() {
    local file="$1"
    local label="$2"
    local timeout="${3:-60}"
    local deadline=$(( $(date +%s) + timeout ))
    while :; do
        if [[ -s "${file}" ]]; then
            harness::ok "received ${label} on MQTT"
            return 0
        fi
        if [[ $(date +%s) -ge ${deadline} ]]; then
            harness::err "no ${label} received within ${timeout}s"
            return 1
        fi
        sleep 1
    done
}

# ---------------------------------------------------------------------------
# Bring the stack up only if needed (same rationale as 06: the channel's
# Microsoft profile drives the Microsoft backend regardless of ASR_PROVIDER).
# ---------------------------------------------------------------------------
if ! harness::_compose ps --status running --services 2>/dev/null | grep -q '^sessionapi$'; then
    harness::log "stack not running, bringing it up"
    harness::up || { harness::err "stack failed to come up"; exit 1; }
fi

harness::log "=== diarization + translation dual-recognizer scenario (Microsoft Azure ASR) ==="

# ---------------------------------------------------------------------------
# Setup: Microsoft profile with diarization enabled and German advertised as a
# discrete translation target, plus a session whose channel has diarization=true
# and translations=[de]. This combination triggers the dual-recognizer path.
# ---------------------------------------------------------------------------
profile_id=$(harness::create_microsoft_profile \
    "diar_translation_microsoft_$(date +%s)" \
    "${AZURE_SPEECH_KEY}" \
    "${AZURE_SPEECH_REGION}" \
    "en-US,fr-FR" \
    "true" \
    "${TARGET_LANG}")
harness::ok "created Microsoft transcriber profile id=${profile_id} (diarization + availableTranslations=${TARGET_LANG})"

session_id=$(harness::create_session_diar_translation "${profile_id}" "${TARGET_LANG}" "diar_tr_microsoft_$(date +%s)")
harness::ok "created session id=${session_id} (channel diarization=true, translations=[${TARGET_LANG}])"

# Confirm the channel actually persisted diarization + a discrete translation
# (guards against a silent validation fallback turning the target external).
session_json=$(harness::get_session "${session_id}")
chan_diar=$(jq -r '.channels[0].diarization' <<< "${session_json}")
chan_tr=$(jq -r --arg t "${TARGET_LANG}" \
    '[.channels[0].translations[]? | select(.target==$t and .mode=="discrete")] | length' <<< "${session_json}")
[[ "${chan_diar}" == "true" ]] || fail "channel diarization did not persist as true (got '${chan_diar}')"
[[ "${chan_tr}" -ge 1 ]] || fail "channel did not persist a discrete '${TARGET_LANG}' translation"
harness::ok "channel persisted diarization=true and discrete translation target '${TARGET_LANG}'"

harness::assert_status "${session_id}" "ready" 30 \
    || fail "initial session status should be ready"

# ---------------------------------------------------------------------------
# Subscribe to the final + final/translations topics early.
# ---------------------------------------------------------------------------
FINAL_LOG=$(mktemp)
TRANSLATIONS_LOG=$(mktemp)

harness::mqtt_subscribe "transcriber/out/${session_id}/+/final"              "${FINAL_LOG}"        >/dev/null
harness::mqtt_subscribe "transcriber/out/${session_id}/+/final/translations" "${TRANSLATIONS_LOG}" >/dev/null
sleep 1  # let subscriptions settle

cleanup_logs() {
    rm -f "${FINAL_LOG}" "${TRANSLATIONS_LOG}"
}
trap 'cleanup_logs; harness::_kill_bg' EXIT

# ---------------------------------------------------------------------------
# Stream real speech over SRT so Azure produces finals with speakerId + a German
# translation. We loop the short clip a few times to give Azure enough audio to
# flush at least one final and one translation.
# ---------------------------------------------------------------------------
harness::log "--- streaming speech fixture over SRT towards ${session_id} ---"
stream_pid=$(harness::stream_srt "${session_id}" 0 "${SPEECH_AUDIO}" 0)
harness::log "SRT stream pid=${stream_pid}"

if ! wait_for_status "${session_id}" "active" 60 >/dev/null; then
    harness::logs sessionapi 50 || true
    harness::logs scheduler 50 || true
    harness::logs transcriber 100 || true
    fail "session did not become 'active' within 60s of streaming"
fi
harness::ok "session is active"

# Wait for a canonical final (the primary's caption) and a translation final.
# Generous timeouts: Azure batches finals at end-of-utterance.
if ! wait_for_nonempty_log "${FINAL_LOG}" "canonical final" 90; then
    harness::logs transcriber 200 || true
    fail "no canonical final emitted — primary recognizer produced nothing"
fi
if ! wait_for_nonempty_log "${TRANSLATIONS_LOG}" "translation final" 60; then
    harness::logs transcriber 200 || true
    fail "no translation final emitted — secondary (TranslationRecognizer) produced nothing"
fi

# Give the Scheduler a moment to persist the latest finals/translations to DB.
sleep 3

# Stop the stream before asserting on the saved transcript.
kill "${stream_pid}" 2>/dev/null || true

# ---------------------------------------------------------------------------
# ASSERT via Session-API HTTP read path (GET /sessions/<id>, withCaptions
# defaults to true). channels[0] carries closedCaptions[] and
# translatedCaptions{segmentId: [...]}.
# ---------------------------------------------------------------------------
result=$(harness::get_session "${session_id}") || fail "GET /sessions/${session_id} failed"

closed_count=$(jq -r '.channels[0].closedCaptions | length' <<< "${result}")
[[ "${closed_count}" -ge 1 ]] \
    || fail "closedCaptions is empty (the empty-saved-transcript bug regressed)"
harness::ok "closedCaptions non-empty (${closed_count} turn(s))"

# Fix A: at least one caption carries a non-null/non-empty locutor. A
# TranslationRecognizer never sets speakerId, so a populated locutor proves the
# primary is a ConversationTranscriber.
locutor_count=$(jq -r '[.channels[0].closedCaptions[] | select(.locutor != null and (.locutor | tostring | length) > 0)] | length' <<< "${result}")
[[ "${locutor_count}" -ge 1 ]] \
    || fail "no closedCaption has a locutor — primary is not a ConversationTranscriber (Fix A regressed)"
harness::ok "at least one closedCaption has a locutor (${locutor_count}) — ConversationTranscriber confirmed"

# Origin-tagging: one caption line per segmentId (no duplicate from the
# secondary). Count of captions must equal count of distinct segmentIds.
distinct_segments=$(jq -r '[.channels[0].closedCaptions[].segmentId] | unique | length' <<< "${result}")
[[ "${closed_count}" -eq "${distinct_segments}" ]] \
    || fail "duplicate captions per segmentId (closed=${closed_count}, distinct=${distinct_segments}) — origin-tagging regressed"
harness::ok "exactly one caption per segmentId (${closed_count} == ${distinct_segments}) — origin-tagging confirmed"

# Secondary: translatedCaptions contains entries for the German target.
de_translations=$(jq -r --arg t "${TARGET_LANG}" \
    '[.channels[0].translatedCaptions[]?[] | select(.targetLang == $t)] | length' <<< "${result}")
[[ "${de_translations}" -ge 1 ]] \
    || fail "no '${TARGET_LANG}' translatedCaptions — secondary TranslationRecognizer output not persisted"
harness::ok "translatedCaptions contain ${de_translations} '${TARGET_LANG}' entry/entries — TranslationRecognizer confirmed"

# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------
kill "${stream_pid}" 2>/dev/null || true
harness::http DELETE "/sessions/${session_id}?force=true" >/dev/null 2>&1 || true
harness::http DELETE "/transcriber_profiles/${profile_id}" >/dev/null 2>&1 || true

harness::ok "Microsoft diarization+translation dual-recognizer scenario PASSED"
