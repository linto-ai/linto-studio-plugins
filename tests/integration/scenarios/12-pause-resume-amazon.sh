#!/usr/bin/env bash
# tests/integration/scenarios/12-pause-resume-amazon.sh
#
# End-to-end validation of the pause/resume feature against a REAL Amazon
# Transcribe Streaming ASR backend. Mirror of 06-pause-resume-microsoft.sh
# but exercising the AmazonTranscriber (Transcriber/ASR/amazon/index.js)
# provider.stop() -> provider.start() cycle against live AWS endpoints.
#
# Authentication model:
# Unlike Microsoft (single API key) Amazon goes through IAM Roles Anywhere:
# Session-API stores an X.509 certificate + private key bundle, and the
# Transcriber spawns the aws_signing_helper binary at start() time to exchange
# them for short-lived STS credentials. This means a working test setup
# requires more than a simple access key/secret pair.
#
# Required environment variables (all must be set, otherwise the scenario
# is SKIPPED, not failed):
#   - AWS_REGION                e.g. eu-west-1
#   - AWS_TRUST_ANCHOR_ARN      IAM Roles Anywhere trust anchor ARN
#   - AWS_PROFILE_ARN           IAM Roles Anywhere profile ARN
#   - AWS_ROLE_ARN              IAM role to assume
#   - AWS_CERTIFICATE_PATH      path to X.509 certificate (PEM)
#   - AWS_PRIVATE_KEY_PATH      path to private key (PEM, optionally PKCS#8)
# Optional:
#   - AWS_PRIVATE_KEY_PASSPHRASE  passphrase for PKCS#8-encrypted keys
#
# AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are *not* used by this provider
# (IAM Roles Anywhere replaces static credentials) but we still check that the
# caller is aware of an AWS setup by requiring AWS_REGION.
#
# What we assert:
#   - An Amazon profile is accepted by Session-API (multipart upload of cert
#     + key, validation of region/trustAnchorArn/profileArn/roleArn)
#   - A session backed by that profile reaches `active` once audio flows
#   - The Transcriber logs "Amazon ASR: Starting stream transcription"
#     (i.e. credentials were obtained via aws_signing_helper and the
#     TranscribeStreamingClient handshake succeeded) before pause
#   - PUT /sessions/:id/pause flips status to `paused`, emits
#     system/out/sessions/paused, and silences transcription topics
#   - PUT /sessions/:id/resume flips status back to `active` AND the
#     Transcriber logs a SECOND "Amazon ASR: Starting stream transcription"
#     line (proof that provider.start() rebuilt the AWS SDK streaming
#     client from scratch — new credentials, new TranscribeStreamingClient,
#     new StartStreamTranscriptionCommand)
#
# Why we lean on container logs rather than partial/final MQTT messages:
# the SRT stream we send is a 440Hz sine wave (audiotestsrc) — AWS Transcribe
# rarely emits transcription results for pure tones, so MQTT silence on the
# partial topic is not a reliable signal that the streaming connection
# succeeded or failed. The transcriber's own log lines emitted in start()
# right after `client.send(command)` resolves are deterministic markers.

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
# Gate on AWS / IAM Roles Anywhere credentials. Skip cleanly if any are
# missing. We require *all* the inputs the Amazon provider actually consumes
# so a half-configured environment still yields a clean skip rather than a
# misleading failure.
# ---------------------------------------------------------------------------
missing=()
[[ -z "${AWS_REGION:-}" ]]              && missing+=("AWS_REGION")
[[ -z "${AWS_TRUST_ANCHOR_ARN:-}" ]]    && missing+=("AWS_TRUST_ANCHOR_ARN")
[[ -z "${AWS_PROFILE_ARN:-}" ]]         && missing+=("AWS_PROFILE_ARN")
[[ -z "${AWS_ROLE_ARN:-}" ]]            && missing+=("AWS_ROLE_ARN")
[[ -z "${AWS_CERTIFICATE_PATH:-}" ]]    && missing+=("AWS_CERTIFICATE_PATH")
[[ -z "${AWS_PRIVATE_KEY_PATH:-}" ]]    && missing+=("AWS_PRIVATE_KEY_PATH")

if [[ ${#missing[@]} -gt 0 ]]; then
    harness::warn "skipping: missing env var(s): ${missing[*]}"
    harness::warn "Amazon ASR requires IAM Roles Anywhere (region, ARNs, certificate, private key)"
    exit 0
fi

# Also gate on the existence of the cert / key files — without them the
# multipart upload would fail anyway, and we prefer a skip over a hard fail
# when the environment is partially wired up.
if [[ ! -f "${AWS_CERTIFICATE_PATH}" ]]; then
    harness::warn "skipping: AWS_CERTIFICATE_PATH=${AWS_CERTIFICATE_PATH} does not exist"
    exit 0
fi
if [[ ! -f "${AWS_PRIVATE_KEY_PATH}" ]]; then
    harness::warn "skipping: AWS_PRIVATE_KEY_PATH=${AWS_PRIVATE_KEY_PATH} does not exist"
    exit 0
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
# index.js loadAsr()), so an "amazon" profile drives the Amazon backend
# regardless of the env default.
# ---------------------------------------------------------------------------
if ! harness::_compose ps --status running --services 2>/dev/null | grep -q '^sessionapi$'; then
    harness::log "stack not running, bringing it up"
    harness::up || { harness::err "stack failed to come up"; exit 1; }
fi

harness::log "=== pause/resume scenario (Amazon Transcribe Streaming ASR) ==="

# ---------------------------------------------------------------------------
# Setup: create an Amazon profile (multipart: config JSON + cert + key) and
# a session bound to it.
# ---------------------------------------------------------------------------
profile_id=$(harness::create_amazon_profile \
    "pause_resume_amazon_$(date +%s)" \
    "${AWS_REGION}" \
    "${AWS_TRUST_ANCHOR_ARN}" \
    "${AWS_PROFILE_ARN}" \
    "${AWS_ROLE_ARN}" \
    "${AWS_CERTIFICATE_PATH}" \
    "${AWS_PRIVATE_KEY_PATH}" \
    "${AWS_PRIVATE_KEY_PASSPHRASE:-}" \
    "fr-FR")
harness::ok "created Amazon transcriber profile id=${profile_id}"

session_id=$(harness::create_session "${profile_id}" "pr_amazon_$(date +%s)")
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

# Marker used to count "Amazon ASR: Starting stream transcription" log lines
# emitted by Transcriber/ASR/amazon/index.js start() right before sending the
# StartStreamTranscriptionCommand. Each successful provider.start() -> AWS
# SDK handshake produces exactly one such line.
READY_MARKER="Amazon ASR: Starting stream transcription"

# Snapshot how many ready lines already exist (other tests, leftovers...) so
# we count only NEW ones produced by this scenario.
baseline_ready=$(count_in_transcriber_logs "${READY_MARKER}" 1000)
harness::log "baseline '${READY_MARKER}' count in transcriber logs: ${baseline_ready}"

# ---------------------------------------------------------------------------
# Start streaming so the session transitions to active.
# A 440Hz sine on SRT is enough to drive the audio pipeline; AWS Transcribe
# will accept the streaming connection even if it does not emit any
# transcription.
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

# Wait until the Amazon SDK reports its first successful handshake. This is
# what tells us we are really talking to AWS (vs. the fake provider): the
# aws_signing_helper exchange succeeded, credentials were obtained, and
# TranscribeStreamingClient.send() resolved.
if ! wait_for_log_count "${READY_MARKER}" "$((baseline_ready + 1))" 45; then
    harness::logs transcriber 200 || true
    fail "Amazon ASR did not signal ready within 45s — check ARNs / cert / key / network"
fi
ready_after_start=$(count_in_transcriber_logs "${READY_MARKER}" 1000)
harness::ok "Amazon ASR is ready (ready-count went ${baseline_ready} -> ${ready_after_start})"

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

# AWS Transcribe can take a beat to flush its final result; use a generous
# silence window to avoid flakiness on slow networks.
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
# scenario. provider.start() must rebuild the Amazon streaming connection
# from scratch — fresh credentials from aws_signing_helper, fresh
# TranscribeStreamingClient, fresh StartStreamTranscriptionCommand.
# ---------------------------------------------------------------------------
harness::log "--- resuming session ---"
harness::http PUT "/sessions/${session_id}/resume" >/dev/null \
    || fail "PUT /resume failed"
harness::assert_status "${session_id}" "active" 15 \
    || fail "session did not transition back to 'active'"

# Expect a SECOND ready line to appear (one more than after the initial start).
if ! wait_for_log_count "${READY_MARKER}" "$((ready_after_start + 1))" 60; then
    harness::logs transcriber 200 || true
    fail "Amazon ASR did not re-handshake after resume — provider.start() likely broken"
fi
harness::ok "Amazon ASR re-handshaked successfully after resume"

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

harness::ok "Amazon pause/resume scenario PASSED"
