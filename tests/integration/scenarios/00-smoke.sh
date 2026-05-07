#!/usr/bin/env bash
# tests/integration/scenarios/00-smoke.sh
#
# Minimal end-to-end smoke check, no streaming involved.
#
#   1. Create a fake-ASR transcriber profile.
#   2. Create a session with one channel using that profile.
#   3. Assert the session status is "ready".
#   4. PUT /sessions/{id}/stop.
#   5. Assert the session status is "terminated".

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../harness/lib.sh
source "${SCRIPT_DIR}/../harness/lib.sh"

harness::install_cleanup_trap

harness::log "=== smoke scenario ==="

profile_id=$(harness::create_transcriber_profile "smoke_fake")
harness::ok "created transcriber profile id=${profile_id}"

session_id=$(harness::create_session "${profile_id}" "smoke_$(date +%s)")
harness::ok "created session id=${session_id}"

harness::assert_status "${session_id}" "ready" 30

harness::log "stopping session ${session_id}"
harness::stop_session "${session_id}"

harness::assert_status "${session_id}" "terminated" 30

harness::ok "smoke scenario PASSED"
