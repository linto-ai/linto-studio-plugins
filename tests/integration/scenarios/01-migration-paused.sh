#!/usr/bin/env bash
# tests/integration/scenarios/01-migration-paused.sh
#
# Validates that the migration 20260507000000-add-paused-session-status:
#   1. Adds the value `paused` to enum `enum_sessions_status`.
#   2. Adds the column `pausedAt` (nullable timestamp) on table `sessions`.
#   3. Allows inserting a session with status='paused' directly in DB.
#
# The scenario assumes the integration stack is already up (run.sh handles
# this); when run standalone it relies on the harness::up helper.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../harness/lib.sh
source "${SCRIPT_DIR}/../harness/lib.sh"

harness::install_cleanup_trap

harness::log "=== migration paused scenario ==="

# Bring the stack up only if it isn't already running.
if ! harness::_compose ps --status running --services 2>/dev/null | grep -q '^database$'; then
    harness::log "stack not running, bringing it up"
    harness::up || { harness::err "stack failed to come up"; exit 1; }
fi

# DB connection vars (must match docker-compose.test.yml).
DB_USER="${DB_USER:-emeeting}"
DB_NAME="${DB_NAME:-emeeting_test}"
DB_SVC="database"

psql_exec() {
    harness::_compose exec -T "${DB_SVC}" \
        env PGPASSWORD=emeeting psql -U "${DB_USER}" -d "${DB_NAME}" -At "$@"
}

psql_meta() {
    # No -A/-t; we want the formatted output (used for \d-style commands).
    harness::_compose exec -T "${DB_SVC}" \
        env PGPASSWORD=emeeting psql -U "${DB_USER}" -d "${DB_NAME}" "$@"
}

# 1. Enum contains 'paused'
harness::log "checking enum_sessions_status contains 'paused'"
enum_values=$(psql_exec -c "SELECT unnest(enum_range(NULL::enum_sessions_status));")
echo "${enum_values}" | grep -qx "paused" || {
    harness::err "enum_sessions_status missing value 'paused'. Got:"
    echo "${enum_values}" >&2
    exit 1
}
harness::ok "enum_sessions_status contains 'paused'"

# 2. Column 'pausedAt' exists on sessions
harness::log "checking sessions.pausedAt column"
col_check=$(psql_exec -c "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name='sessions' AND column_name='pausedAt';")
if [[ -z "${col_check}" ]]; then
    harness::err "column 'pausedAt' not found on table 'sessions'"
    psql_meta -c "\\d sessions" >&2 || true
    exit 1
fi
harness::ok "sessions.pausedAt exists -> ${col_check}"

# Cross-check via \d for completeness (must contain pausedAt token).
desc=$(psql_meta -c "\\d sessions" || true)
if ! grep -q 'pausedAt' <<< "${desc}"; then
    harness::err "\\d sessions output does not mention pausedAt"
    echo "${desc}" >&2
    exit 1
fi

# 3. Insert a row with status='paused'
TEST_SESSION_ID="00000000-0000-0000-0000-000000000001"

# Defensive cleanup before insert (in case of stale data).
psql_exec -c "DELETE FROM sessions WHERE id='${TEST_SESSION_ID}';" >/dev/null

harness::log "inserting session with status='paused'"
insert_sql="INSERT INTO sessions (id, name, status, visibility, \"createdAt\", \"updatedAt\") VALUES ('${TEST_SESSION_ID}', 'test-pause', 'paused', 'private', NOW(), NOW());"
if ! psql_exec -c "${insert_sql}" >/dev/null; then
    harness::err "failed to insert a session with status='paused'"
    exit 1
fi

# Read it back.
read_back=$(psql_exec -c "SELECT status FROM sessions WHERE id='${TEST_SESSION_ID}';")
if [[ "${read_back}" != "paused" ]]; then
    harness::err "expected status=paused, got '${read_back}'"
    psql_exec -c "DELETE FROM sessions WHERE id='${TEST_SESSION_ID}';" >/dev/null || true
    exit 1
fi
harness::ok "inserted and read back session with status=paused"

# Cleanup
psql_exec -c "DELETE FROM sessions WHERE id='${TEST_SESSION_ID}';" >/dev/null

harness::ok "migration paused scenario PASSED"
