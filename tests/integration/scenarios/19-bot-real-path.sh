#!/usr/bin/env bash
# tests/integration/scenarios/19-bot-real-path.sh
#
# Exercises the REAL bot capture path with NO external meeting room and NO cloud
# ASR. Unlike scenario 18 (which mocks the wire with ws-stream-bot.js + a fake
# ASR), this runs the ACTUAL BotService modules end-to-end:
#
#   in-page WebRTC loopback page (synthetic oscillator track over a real
#   RTCPeerConnection offer/answer to itself)
#     -> real BrowserPool (headless Chromium)
#     -> real webrtc-intercept (injected, patches RTCPeerConnection, captures the
#        inbound track, resamples to 16k S16LE)
#     -> real LocalAudioServer (loopback ws)
#     -> real Bot (test manifest, mcu pass-through)
#     -> real TranscriberStream (real init/ACK handshake + audio forwarding)
#     -> a stub Transcriber WS that acks and counts the PCM frames it receives.
#
# The capture chain (BrowserPool, webrtc-intercept, LocalAudioServer,
# TranscriberStream) is unmodified production bot code, driven directly so the
# test leaves a ZERO footprint in BotService (no test manifest file — the
# BotService unit suite asserts bot/manifests/ holds exactly the production set).
# The heavy lifting lives in the node harness
# (tests/integration/harness/bot-real-path.js); this script just gates on
# Chromium and interprets its exit code.
#
# What this covers vs. does NOT:
#   COVERS  : BrowserPool launch + context, getInterceptScript injection, the
#             in-page RTCPeerConnection-track capture + 16k S16LE resample, the
#             loopback LocalAudioServer wire format, Bot pass-through audio
#             emission, and the TranscriberStream init/ACK handshake + audio
#             forwarding to a Transcriber-shaped socket — i.e. real PCM captured
#             in a real browser reaches the Transcriber side.
#   DOES NOT: the SFU AudioMixer per-participant mix + energy VAD (deterministic
#             participant mapping needs a real LiveKit/Jitsi client; the mixer is
#             covered by BotService/tests/AudioMixer.test.js), real ASR/captions
#             (default `fake` provider; no cloud keys), and the Scheduler<->bot
#             MQTT control plane (covered by BotService/tests/BrokerClient.test.js).
#
# CI-safe: when headless Chromium cannot be launched (e.g. CI without
# `npx playwright install chromium`, or a Playwright/browser build mismatch), the
# node harness exits 42 and this scenario SKIPS cleanly — it never fails the run.
# Uses no cloud secrets (the stub Transcriber stands in for the ASR).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../harness/lib.sh
source "${SCRIPT_DIR}/../harness/lib.sh"

harness::install_cleanup_trap

HARNESS_DIR="${SCRIPT_DIR}/../harness"
NODE_HARNESS="${HARNESS_DIR}/bot-real-path.js"
# The bot modules require `live-srt-lib`, `playwright` and `ws`, all installed in
# BotService/node_modules (+ ../lib). Run node from there so they resolve.
BOTSERVICE_DIR="${HARNESS_REPO_ROOT}/BotService"

SKIP_EXIT=42

fail() { harness::err "FAIL: $*"; exit 1; }

# ── Pre-flight gates (skip cleanly, never fail, when prerequisites are absent) ──
if ! command -v node >/dev/null 2>&1; then
    harness::warn "node not found on host — skipping scenario 19 (real bot path)"
    harness::ok "scenario 19 skipped (no node)"
    exit 0
fi

if [[ ! -d "${BOTSERVICE_DIR}/node_modules/playwright" ]]; then
    harness::warn "BotService/node_modules/playwright missing — run 'cd BotService && npm ci' to enable scenario 19"
    harness::ok "scenario 19 skipped (playwright not installed)"
    exit 0
fi

if [[ ! -f "${NODE_HARNESS}" ]]; then
    fail "node harness not found: ${NODE_HARNESS}"
fi

harness::log "=== scenario 19: real bot capture path (browser -> capture -> transcriber) ==="
harness::log "running node harness from ${BOTSERVICE_DIR}"

# Run the node harness. It self-gates on Chromium availability and returns:
#   0  -> PASS, 42 -> SKIP (no Chromium), anything else -> FAIL.
set +e
( cd "${BOTSERVICE_DIR}" && node "${NODE_HARNESS}" )
rc=$?
set -e

case "${rc}" in
    0)
        harness::ok "scenario 19 passed (real captured PCM reached the Transcriber)"
        exit 0
        ;;
    "${SKIP_EXIT}")
        harness::warn "headless Chromium unavailable in this environment — skipping"
        harness::ok "scenario 19 skipped (no Chromium)"
        exit 0
        ;;
    *)
        fail "node harness exited ${rc} (real bot path broke)"
        ;;
esac
