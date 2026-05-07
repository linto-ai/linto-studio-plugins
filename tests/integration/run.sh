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

set -uo pipefail

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
done

if [[ ${#failures[@]} -gt 0 ]]; then
    harness::err "${#failures[@]} scenario(s) failed: ${failures[*]}"
    exit 1
fi

harness::ok "all scenarios passed"
exit 0
