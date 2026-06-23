#!/bin/sh
# Probe the BotService Healthcheck HTTP endpoint (see components/Healthcheck).
# Mirrors the Transcriber's nc-based probe; succeeds only when the JSON liveness
# payload reports {"status":"ok"}.
printf 'GET / HTTP/1.0\r\n\r\n' | nc -w 1 localhost "$BOTSERVICE_HEALTHCHECK_HTTP" | grep -q '"status":"ok"' || exit 1
