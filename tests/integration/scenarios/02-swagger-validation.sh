#!/usr/bin/env bash
# tests/integration/scenarios/02-swagger-validation.sh
#
# Validates the Session-API swagger updates that introduced pause/resume:
#   1. The two JSON files are syntactically valid (jq empty).
#   2. The SessionAnswerBase schema has 'paused' in status.enum and a
#      'pausedAt' property.
#   3. The /sessions/{id}/pause and /sessions/{id}/resume PUT routes are
#      defined in the api file.
#   4. Best-effort: the running Session-API exposes the swagger doc.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../harness/lib.sh
source "${SCRIPT_DIR}/../harness/lib.sh"

harness::install_cleanup_trap

harness::log "=== swagger validation scenario ==="

REPO_ROOT="${HARNESS_REPO_ROOT}"
SWAGGER_DIR="${REPO_ROOT}/Session-API/components/WebServer/routes/api-docs/swagger"
API_FILE="${SWAGGER_DIR}/api/sessions.json"
SCHEMA_FILE="${SWAGGER_DIR}/components/schemas/sessions.json"

# 1. JSON validity
harness::log "validating JSON syntax"
for f in "${API_FILE}" "${SCHEMA_FILE}"; do
    if [[ ! -f "${f}" ]]; then
        harness::err "missing swagger file: ${f}"
        exit 1
    fi
    if ! jq empty "${f}" 2>/dev/null; then
        harness::err "invalid JSON: ${f}"
        jq . "${f}" >&2 || true
        exit 1
    fi
done
harness::ok "swagger JSON files are syntactically valid"

# 2a. status enum contains 'paused'
harness::log "checking SessionAnswerBase.status.enum contains 'paused'"
if ! jq -e '.SessionAnswerBase.properties.status.enum | index("paused")' "${SCHEMA_FILE}" >/dev/null; then
    harness::err "'paused' missing from SessionAnswerBase.properties.status.enum"
    jq '.SessionAnswerBase.properties.status' "${SCHEMA_FILE}" >&2 || true
    exit 1
fi
harness::ok "SessionAnswerBase.status.enum contains 'paused'"

# 2b. pausedAt property
harness::log "checking SessionAnswerBase.pausedAt property"
if ! jq -e '.SessionAnswerBase.properties.pausedAt' "${SCHEMA_FILE}" >/dev/null; then
    harness::err "'pausedAt' missing from SessionAnswerBase.properties"
    jq '.SessionAnswerBase.properties | keys' "${SCHEMA_FILE}" >&2 || true
    exit 1
fi
harness::ok "SessionAnswerBase.pausedAt is defined"

# 3. routes /sessions/{id}/pause and /resume
harness::log "checking pause/resume routes are defined"
if ! jq -e '."/sessions/{id}/pause".put' "${API_FILE}" >/dev/null; then
    harness::err "PUT /sessions/{id}/pause is not defined in ${API_FILE}"
    jq 'keys' "${API_FILE}" >&2 || true
    exit 1
fi
harness::ok "PUT /sessions/{id}/pause is defined"

if ! jq -e '."/sessions/{id}/resume".put' "${API_FILE}" >/dev/null; then
    harness::err "PUT /sessions/{id}/resume is not defined in ${API_FILE}"
    jq 'keys' "${API_FILE}" >&2 || true
    exit 1
fi
harness::ok "PUT /sessions/{id}/resume is defined"

# 4. Best-effort live check — only if the API is reachable.
SWAGGER_URL_CANDIDATES=(
    "${HARNESS_API_BASE}/api-docs"
    "${HARNESS_API_BASE}/api-docs/"
    "${HARNESS_API_BASE}/api-docs/swagger.json"
    "${HARNESS_API_BASE}/api-docs.json"
    "${HARNESS_API_BASE}/v1/api-docs"
)

harness::log "best-effort: probing live swagger endpoint"
hit=""
for url in "${SWAGGER_URL_CANDIDATES[@]}"; do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "${url}" 2>/dev/null || echo "000")
    if [[ "${code}" =~ ^2 ]]; then
        hit="${url}"
        harness::ok "swagger endpoint reachable at ${url} (HTTP ${code})"
        break
    fi
done
if [[ -z "${hit}" ]]; then
    harness::warn "no swagger HTTP endpoint reachable (skipping live probe)"
fi

harness::ok "swagger validation scenario PASSED"
