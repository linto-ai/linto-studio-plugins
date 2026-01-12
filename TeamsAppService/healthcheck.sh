#!/bin/sh

PORT="${TEAMSAPPSERVICE_HTTPS_PORT:-443}"

curl -sf -k "https://localhost:${PORT}/healthcheck" > /dev/null 2>&1
exit $?
