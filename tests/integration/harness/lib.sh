#!/usr/bin/env bash
# tests/integration/harness/lib.sh
#
# Reusable bash helpers for the E-Meeting integration test harness.
#
# Usage:
#   source tests/integration/harness/lib.sh
#
# All public helpers are namespaced under `harness::*`.
# Configuration is exposed via HARNESS_* env vars; defaults match
# tests/integration/docker-compose.test.yml.

set -uo pipefail

# ---------------------------------------------------------------------------
# Resolve repo root (the directory containing this file is .../tests/integration/harness)
# ---------------------------------------------------------------------------
HARNESS_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS_TEST_DIR="$(cd "${HARNESS_LIB_DIR}/.." && pwd)"
HARNESS_REPO_ROOT="$(cd "${HARNESS_TEST_DIR}/../.." && pwd)"
HARNESS_COMPOSE_FILE="${HARNESS_COMPOSE_FILE:-${HARNESS_TEST_DIR}/docker-compose.test.yml}"
HARNESS_PROJECT_NAME="${HARNESS_PROJECT_NAME:-emeeting-integration-test}"

# Endpoints (host-side)
HARNESS_API_BASE="${HARNESS_API_BASE:-http://localhost:8001}"
HARNESS_API_PREFIX="${HARNESS_API_PREFIX:-/v1}"
HARNESS_MQTT_HOST="${HARNESS_MQTT_HOST:-127.0.0.1}"
HARNESS_MQTT_PORT="${HARNESS_MQTT_PORT:-1884}"
HARNESS_SRT_HOST="${HARNESS_SRT_HOST:-127.0.0.1}"
HARNESS_SRT_PORT="${HARNESS_SRT_PORT:-18889}"
HARNESS_RTMP_HOST="${HARNESS_RTMP_HOST:-127.0.0.1}"
HARNESS_RTMP_PORT="${HARNESS_RTMP_PORT:-11935}"
HARNESS_WS_HOST="${HARNESS_WS_HOST:-127.0.0.1}"
HARNESS_WS_PORT="${HARNESS_WS_PORT:-18890}"
HARNESS_WS_ENDPOINT="${HARNESS_WS_ENDPOINT:-transcriber-ws}"
HARNESS_STREAMING_PASSPHRASE="${HARNESS_STREAMING_PASSPHRASE:-testpassphrase}"

# Generic timing
HARNESS_HEALTHY_TIMEOUT="${HARNESS_HEALTHY_TIMEOUT:-180}"   # seconds
HARNESS_HTTP_TIMEOUT="${HARNESS_HTTP_TIMEOUT:-30}"

# Track background processes started by the harness so we can clean up.
declare -a _HARNESS_BG_PIDS=()

# ---------------------------------------------------------------------------
# Logging helpers
# ---------------------------------------------------------------------------
harness::log()  { printf '\033[1;34m[harness]\033[0m %s\n' "$*" >&2; }
harness::ok()   { printf '\033[1;32m[ok]     \033[0m %s\n' "$*" >&2; }
harness::warn() { printf '\033[1;33m[warn]   \033[0m %s\n' "$*" >&2; }
harness::err()  { printf '\033[1;31m[err]    \033[0m %s\n' "$*" >&2; }

# ---------------------------------------------------------------------------
# Compose wrappers
# ---------------------------------------------------------------------------
harness::_compose() {
    docker compose -p "${HARNESS_PROJECT_NAME}" -f "${HARNESS_COMPOSE_FILE}" "$@"
}

# Bring the stack up and wait until every service reports healthy.
# Services without a healthcheck (e.g. migration which is run-once) are
# skipped after we make sure they at least exited successfully.
harness::up() {
    harness::log "Starting integration stack (${HARNESS_COMPOSE_FILE})"
    harness::_compose up -d --build --remove-orphans

    harness::log "Waiting for services to become healthy (timeout=${HARNESS_HEALTHY_TIMEOUT}s)"
    local deadline=$(( $(date +%s) + HARNESS_HEALTHY_TIMEOUT ))
    local services
    services=$(harness::_compose config --services)

    while :; do
        local pending=()
        for svc in ${services}; do
            local cid
            # Use --all so we still see one-shot containers that have already
            # exited (e.g. the migration service).
            cid=$(harness::_compose ps -aq "${svc}" 2>/dev/null | head -n1 || true)
            [[ -z "${cid}" ]] && { pending+=("${svc}(no container)"); continue; }

            local state
            state=$(docker inspect -f '{{.State.Status}}' "${cid}" 2>/dev/null || echo "missing")
            local health
            health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${cid}" 2>/dev/null || echo "none")
            local exit_code
            exit_code=$(docker inspect -f '{{.State.ExitCode}}' "${cid}" 2>/dev/null || echo "?")

            case "${state}/${health}" in
                running/healthy) : ;;                           # ok
                running/none)    : ;;                           # ok, no healthcheck declared
                exited/none)
                    if [[ "${exit_code}" != "0" ]]; then
                        harness::err "Service ${svc} exited with code ${exit_code}"
                        harness::logs "${svc}" 50 || true
                        return 1
                    fi
                    ;;
                exited/*)
                    if [[ "${exit_code}" != "0" ]]; then
                        harness::err "Service ${svc} exited with code ${exit_code} (health=${health})"
                        harness::logs "${svc}" 50 || true
                        return 1
                    fi
                    ;;
                *) pending+=("${svc}(${state}/${health})") ;;
            esac
        done

        if [[ ${#pending[@]} -eq 0 ]]; then
            harness::ok "All services healthy"
            return 0
        fi

        if [[ $(date +%s) -ge ${deadline} ]]; then
            harness::err "Timeout waiting for services: ${pending[*]}"
            harness::_compose ps
            return 1
        fi

        sleep 2
    done
}

harness::down() {
    harness::log "Stopping integration stack"
    harness::_kill_bg
    harness::_compose down -v --remove-orphans || true
}

# Tail the logs of one service.
harness::logs() {
    local svc="$1"
    local n="${2:-200}"
    harness::_compose logs --tail="${n}" --no-color "${svc}"
}

# ---------------------------------------------------------------------------
# Background process tracking
# ---------------------------------------------------------------------------
harness::_track_bg() {
    _HARNESS_BG_PIDS+=("$1")
}

harness::_kill_bg() {
    local pid
    for pid in "${_HARNESS_BG_PIDS[@]:-}"; do
        [[ -z "${pid}" ]] && continue
        kill "${pid}" 2>/dev/null || true
    done
    _HARNESS_BG_PIDS=()
}

# ---------------------------------------------------------------------------
# HTTP helper: harness::http METHOD URL [BODY]
#
#   * URL is taken as-is if it starts with http(s)://, otherwise prefixed with
#     "${HARNESS_API_BASE}${HARNESS_API_PREFIX}".
#   * Asserts HTTP 2xx, prints the response body to stdout (compact JSON if
#     parseable, otherwise raw).
#   * Returns 1 on non-2xx.
# ---------------------------------------------------------------------------
harness::http() {
    local method="$1"
    local url="$2"
    local body="${3:-}"

    if [[ "${url}" != http*://* ]]; then
        url="${HARNESS_API_BASE}${HARNESS_API_PREFIX}${url}"
    fi

    local tmp
    tmp=$(mktemp)
    local code
    if [[ -n "${body}" ]]; then
        code=$(curl -sS -o "${tmp}" -w '%{http_code}' \
            --max-time "${HARNESS_HTTP_TIMEOUT}" \
            -X "${method}" \
            -H 'Content-Type: application/json' \
            -d "${body}" \
            "${url}")
    else
        code=$(curl -sS -o "${tmp}" -w '%{http_code}' \
            --max-time "${HARNESS_HTTP_TIMEOUT}" \
            -X "${method}" \
            -H 'Accept: application/json' \
            "${url}")
    fi

    if [[ "${code}" =~ ^2 ]]; then
        if jq -e . >/dev/null 2>&1 < "${tmp}"; then
            jq -c . < "${tmp}"
        else
            cat "${tmp}"
        fi
        rm -f "${tmp}"
        return 0
    else
        harness::err "HTTP ${method} ${url} -> ${code}"
        cat "${tmp}" >&2 || true
        rm -f "${tmp}"
        return 1
    fi
}

# Convenience wrappers
harness::get()  { harness::http GET  "$1"; }
harness::post() { harness::http POST "$1" "$2"; }
harness::put()  { harness::http PUT  "$1" "${2:-}"; }

# ---------------------------------------------------------------------------
# Domain helpers
# ---------------------------------------------------------------------------

# Create a fake-ASR transcriber profile, prints the new profile id.
# Args: [NAME]
harness::create_transcriber_profile() {
    local name="${1:-fake_profile}"
    local payload
    payload=$(cat <<EOF
{
  "config": {
    "type": "fake",
    "name": "${name}",
    "description": "fake provider for integration tests",
    "languages": [
      { "candidate": "fr-FR" }
    ]
  }
}
EOF
    )
    local resp
    resp=$(harness::post "/transcriber_profiles" "${payload}") || return 1
    # Some Session-API versions return the created profile, some return only id.
    # Be defensive and try a few jq paths.
    local id
    id=$(jq -r '.id // .profileId // .data.id // empty' <<< "${resp}")
    if [[ -z "${id}" ]]; then
        # Fallback: fetch the list and grab the one matching name.
        id=$(harness::get "/transcriber_profiles" \
            | jq -r --arg n "${name}" '[.[] | select(.config.name==$n)] | last | .id // empty')
    fi
    if [[ -z "${id}" ]]; then
        harness::err "Could not extract transcriber profile id from response: ${resp}"
        return 1
    fi
    echo "${id}"
}

# Create a Microsoft (Azure) ASR transcriber profile, prints the new profile id.
# Args: NAME KEY REGION [LANGUAGES_CSV]
#
# LANGUAGES_CSV defaults to "fr-FR". Multiple BCP47 candidates can be passed
# as a comma-separated list (e.g. "fr-FR,en-US"). Each candidate is wrapped in
# the {"candidate": "..."} shape expected by Session-API.
#
# Session-API encrypts the key at rest (Security.encrypt) before storing it.
harness::create_microsoft_profile() {
    local name="$1"
    local key="$2"
    local region="$3"
    local langs_csv="${4:-fr-FR}"

    # Build the JSON array of language candidates from a comma-separated list.
    local langs_json
    langs_json=$(jq -nc --arg csv "${langs_csv}" \
        '$csv | split(",") | map({candidate: (. | gsub("^\\s+|\\s+$"; ""))})')

    local payload
    payload=$(jq -nc \
        --arg name "${name}" \
        --arg key "${key}" \
        --arg region "${region}" \
        --argjson langs "${langs_json}" \
        '{config: {
            type: "microsoft",
            name: $name,
            description: "microsoft provider for integration tests",
            languages: $langs,
            region: $region,
            key: $key
        }}')

    local resp
    resp=$(harness::post "/transcriber_profiles" "${payload}") || return 1
    local id
    id=$(jq -r '.id // .profileId // .data.id // empty' <<< "${resp}")
    if [[ -z "${id}" ]]; then
        id=$(harness::get "/transcriber_profiles" \
            | jq -r --arg n "${name}" '[.[] | select(.config.name==$n)] | last | .id // empty')
    fi
    if [[ -z "${id}" ]]; then
        harness::err "Could not extract microsoft transcriber profile id from response: ${resp}"
        return 1
    fi
    echo "${id}"
}

# Create a session with one channel bound to the given profile id.
# Args: PROFILE_ID [SESSION_NAME]
# Prints the session id.
harness::create_session() {
    local profile_id="$1"
    local name="${2:-it_session_$(date +%s%N)}"

    local payload
    payload=$(cat <<EOF
{
  "name": "${name}",
  "channels": [
    {
      "name": "ch0",
      "transcriberProfileId": ${profile_id}
    }
  ]
}
EOF
    )
    local resp
    resp=$(harness::post "/sessions" "${payload}") || return 1
    local id
    id=$(jq -r '.id // .session.id // empty' <<< "${resp}")
    if [[ -z "${id}" ]]; then
        # Some implementations only return a confirmation; look the session up by name.
        id=$(harness::get "/sessions?searchName=${name}" \
            | jq -r '.sessions[0].id // empty')
    fi
    if [[ -z "${id}" ]]; then
        harness::err "Could not extract session id from response: ${resp}"
        return 1
    fi
    echo "${id}"
}

# Fetch a session by id.
harness::get_session() {
    local id="$1"
    harness::get "/sessions/${id}"
}

# Assert session.status == EXPECTED.
# Args: SESSION_ID EXPECTED_STATUS [TIMEOUT_SECONDS]
harness::assert_status() {
    local id="$1"
    local expected="$2"
    local timeout="${3:-30}"
    local deadline=$(( $(date +%s) + timeout ))
    local last=""

    while :; do
        last=$(harness::get_session "${id}" | jq -r '.status // empty' 2>/dev/null || echo "")
        if [[ "${last}" == "${expected}" ]]; then
            harness::ok "session ${id} status=${expected}"
            return 0
        fi
        if [[ $(date +%s) -ge ${deadline} ]]; then
            harness::err "session ${id} status=${last} (expected ${expected})"
            return 1
        fi
        sleep 1
    done
}

# Stop a session.
harness::stop_session() {
    local id="$1"
    harness::put "/sessions/${id}/stop" >/dev/null
}

# ---------------------------------------------------------------------------
# Streaming helpers
# ---------------------------------------------------------------------------
# All streaming helpers run in the background and return the PID on stdout
# (also stored in _HARNESS_BG_PIDS so harness::down kills them).

# harness::stream_srt SESSION_ID CHANNEL_INDEX AUDIO_FILE [DURATION]
harness::stream_srt() {
    local session_id="$1"
    local channel_index="${2:-0}"
    local audio="$3"
    local duration="${4:-0}"   # 0 = play full file

    local uri="srt://${HARNESS_SRT_HOST}:${HARNESS_SRT_PORT}?streamid=${session_id},${channel_index}&passphrase=${HARNESS_STREAMING_PASSPHRASE}"
    harness::log "stream_srt: ${audio} -> ${uri}"
    local cmd=(gst-launch-1.0 -q
        filesrc "location=${audio}"
        ! decodebin
        ! audioconvert
        ! audioresample
        ! avenc_ac3
        ! mpegtsmux
        ! rtpmp2tpay
        ! "srtsink" "uri=${uri}")
    "${cmd[@]}" >/dev/null 2>&1 &
    local pid=$!
    harness::_track_bg "${pid}"
    if [[ "${duration}" -gt 0 ]]; then
        ( sleep "${duration}" && kill "${pid}" 2>/dev/null ) &
        harness::_track_bg "$!"
    fi
    echo "${pid}"
}

# harness::stream_srt_loop SESSION_ID CHANNEL_INDEX [DURATION]
#
# Continuous SRT stream backed by gst's audiotestsrc (a 440Hz sine generator),
# which never emits EOS. Useful for long-running scenarios (pause/resume,
# idleness) where we need a persistent audio source. The third positional arg
# is kept for forward compatibility with stream_srt's signature but ignored.
harness::stream_srt_loop() {
    local session_id="$1"
    local channel_index="${2:-0}"
    # Optional 3rd arg (audio file) is intentionally ignored: audiotestsrc has
    # no EOS so we don't need a real file. Keeping the slot lets callers pass
    # the same args as stream_srt without surprises.
    local _ignored_audio="${3:-}"
    local duration="${4:-0}"

    local uri="srt://${HARNESS_SRT_HOST}:${HARNESS_SRT_PORT}?streamid=${session_id},${channel_index}&passphrase=${HARNESS_STREAMING_PASSPHRASE}"
    harness::log "stream_srt_loop (audiotestsrc) -> ${uri}"
    local cmd=(gst-launch-1.0 -q
        audiotestsrc "is-live=true" "wave=sine" "freq=440"
        ! audioconvert
        ! audioresample
        ! "audio/x-raw,rate=48000,channels=2"
        ! avenc_ac3
        ! mpegtsmux
        ! rtpmp2tpay
        ! "srtsink" "uri=${uri}")
    "${cmd[@]}" >/dev/null 2>&1 &
    local pid=$!
    harness::_track_bg "${pid}"
    if [[ "${duration}" -gt 0 ]]; then
        ( sleep "${duration}" && kill "${pid}" 2>/dev/null ) &
        harness::_track_bg "$!"
    fi
    echo "${pid}"
}

# harness::stream_rtmp SESSION_ID CHANNEL_INDEX AUDIO_FILE [DURATION]
harness::stream_rtmp() {
    local session_id="$1"
    local channel_index="${2:-0}"
    local audio="$3"
    local duration="${4:-0}"

    local uri="rtmp://${HARNESS_RTMP_HOST}:${HARNESS_RTMP_PORT}/${session_id}/${channel_index}"
    harness::log "stream_rtmp: ${audio} -> ${uri}"
    ffmpeg -hide_banner -loglevel error -re -i "${audio}" \
        -ar 16000 -ac 1 -c:a aac -f flv "${uri}" >/dev/null 2>&1 &
    local pid=$!
    harness::_track_bg "${pid}"
    if [[ "${duration}" -gt 0 ]]; then
        ( sleep "${duration}" && kill "${pid}" 2>/dev/null ) &
        harness::_track_bg "$!"
    fi
    echo "${pid}"
}

# harness::stream_rtmp_loop SESSION_ID CHANNEL_INDEX [DURATION]
#
# Continuous RTMP stream backed by ffmpeg's lavfi sine generator (never emits
# EOS). Useful for long-running scenarios (pause/resume) where we need a
# persistent audio source over RTMP. The third positional arg (audio file) is
# kept for forward compatibility with stream_rtmp's signature but ignored.
harness::stream_rtmp_loop() {
    local session_id="$1"
    local channel_index="${2:-0}"
    # Optional 3rd arg (audio file) is intentionally ignored: lavfi sine has
    # no EOS so we don't need a real file. Keeping the slot lets callers pass
    # the same args as stream_rtmp without surprises.
    local _ignored_audio="${3:-}"
    local duration="${4:-0}"

    local uri="rtmp://${HARNESS_RTMP_HOST}:${HARNESS_RTMP_PORT}/${session_id}/${channel_index}"
    harness::log "stream_rtmp_loop (lavfi sine) -> ${uri}"
    # duration=0 in lavfi sine means infinite. AAC + FLV is the canonical
    # RTMP container expected by the transcriber's rtmp ingress.
    ffmpeg -hide_banner -loglevel error -re \
        -f lavfi -i "sine=frequency=440:sample_rate=16000:duration=0" \
        -ar 16000 -ac 1 -c:a aac -f flv "${uri}" >/dev/null 2>&1 &
    local pid=$!
    harness::_track_bg "${pid}"
    if [[ "${duration}" -gt 0 ]]; then
        ( sleep "${duration}" && kill "${pid}" 2>/dev/null ) &
        harness::_track_bg "$!"
    fi
    echo "${pid}"
}

# harness::stream_ws SESSION_ID CHANNEL_INDEX AUDIO_FILE [DURATION]
#
# Uses the bundled node helper so we don't need an external nodejs program.
harness::stream_ws() {
    local session_id="$1"
    local channel_index="${2:-0}"
    local audio="$3"
    local duration="${4:-0}"

    local helper="${HARNESS_LIB_DIR}/ws-stream.js"
    local url="ws://${HARNESS_WS_HOST}:${HARNESS_WS_PORT}/${HARNESS_WS_ENDPOINT}/${session_id},${channel_index}"
    harness::log "stream_ws: ${audio} -> ${url}"

    # Convert/decode anything to s16le mono 16k via ffmpeg, pipe to node which
    # forwards 200ms PCM chunks to the WebSocket.
    ( ffmpeg -hide_banner -loglevel error -re -i "${audio}" \
        -ar 16000 -ac 1 -f s16le pipe:1 \
        | node "${helper}" "${url}" ) >/dev/null 2>&1 &
    local pid=$!
    harness::_track_bg "${pid}"
    if [[ "${duration}" -gt 0 ]]; then
        ( sleep "${duration}" && kill "${pid}" 2>/dev/null ) &
        harness::_track_bg "$!"
    fi
    echo "${pid}"
}

# harness::stream_ws_loop SESSION_ID CHANNEL_INDEX [AUDIO_IGNORED] [DURATION]
#
# Continuous WebSocket stream backed by ffmpeg's lavfi sine generator (never
# emits EOS). Useful for long-running scenarios (pause/resume) where we need a
# persistent audio source over WS. The third positional arg (audio file) is
# kept for forward compatibility with stream_ws's signature but ignored.
harness::stream_ws_loop() {
    local session_id="$1"
    local channel_index="${2:-0}"
    # Optional 3rd arg (audio file) is intentionally ignored: lavfi sine has
    # no EOS so we don't need a real file. Keeping the slot lets callers pass
    # the same args as stream_ws without surprises.
    local _ignored_audio="${3:-}"
    local duration="${4:-0}"

    local helper="${HARNESS_LIB_DIR}/ws-stream.js"
    local url="ws://${HARNESS_WS_HOST}:${HARNESS_WS_PORT}/${HARNESS_WS_ENDPOINT}/${session_id},${channel_index}"
    harness::log "stream_ws_loop (lavfi sine) -> ${url}"

    # duration=0 in lavfi sine means infinite. ffmpeg outputs raw s16le mono
    # 16kHz PCM on stdout, which the node helper forwards as 200ms binary
    # chunks over the WebSocket. stdin never closes so the node helper keeps
    # running until killed.
    ( ffmpeg -hide_banner -loglevel error -re \
        -f lavfi -i "sine=frequency=440:sample_rate=16000:duration=0" \
        -ar 16000 -ac 1 -f s16le pipe:1 \
        | node "${helper}" "${url}" ) >/dev/null 2>&1 &
    local pid=$!
    harness::_track_bg "${pid}"
    if [[ "${duration}" -gt 0 ]]; then
        ( sleep "${duration}" && kill "${pid}" 2>/dev/null ) &
        harness::_track_bg "$!"
    fi
    echo "${pid}"
}

# ---------------------------------------------------------------------------
# MQTT helpers
# ---------------------------------------------------------------------------

# harness::mqtt_subscribe TOPIC OUTPUT_FILE
# Subscribes in the background, appends each received message + newline to
# OUTPUT_FILE. Returns the mosquitto_sub PID.
harness::mqtt_subscribe() {
    local topic="$1"
    local out="$2"
    : > "${out}"
    mosquitto_sub -h "${HARNESS_MQTT_HOST}" -p "${HARNESS_MQTT_PORT}" \
        -t "${topic}" -v >> "${out}" 2>/dev/null &
    local pid=$!
    harness::_track_bg "${pid}"
    echo "${pid}"
}

# harness::mqtt_assert_silent TOPIC SECONDS
# Returns 0 if no message arrives on TOPIC during the window, 1 otherwise.
harness::mqtt_assert_silent() {
    local topic="$1"
    local seconds="$2"
    local tmp
    tmp=$(mktemp)
    timeout "${seconds}" mosquitto_sub -h "${HARNESS_MQTT_HOST}" -p "${HARNESS_MQTT_PORT}" \
        -t "${topic}" -C 1 > "${tmp}" 2>/dev/null
    if [[ -s "${tmp}" ]]; then
        harness::err "expected silence on ${topic} for ${seconds}s but got: $(cat "${tmp}")"
        rm -f "${tmp}"
        return 1
    fi
    rm -f "${tmp}"
    harness::ok "silent on ${topic} for ${seconds}s"
    return 0
}

# harness::mqtt_assert_received TOPIC PATTERN [TIMEOUT]
# Waits until a message matching PATTERN (grep regex) is received on TOPIC,
# or TIMEOUT seconds elapse.
harness::mqtt_assert_received() {
    local topic="$1"
    local pattern="$2"
    local timeout="${3:-15}"
    local tmp
    tmp=$(mktemp)

    # mosquitto_sub doesn't natively grep; use a small loop.
    ( mosquitto_sub -h "${HARNESS_MQTT_HOST}" -p "${HARNESS_MQTT_PORT}" \
        -t "${topic}" > "${tmp}" 2>/dev/null ) &
    local pid=$!
    harness::_track_bg "${pid}"

    local deadline=$(( $(date +%s) + timeout ))
    while :; do
        if grep -qE "${pattern}" "${tmp}" 2>/dev/null; then
            harness::ok "received message on ${topic} matching /${pattern}/"
            kill "${pid}" 2>/dev/null || true
            rm -f "${tmp}"
            return 0
        fi
        if [[ $(date +%s) -ge ${deadline} ]]; then
            harness::err "no message matching /${pattern}/ on ${topic} within ${timeout}s"
            kill "${pid}" 2>/dev/null || true
            rm -f "${tmp}"
            return 1
        fi
        sleep 0.5
    done
}

# ---------------------------------------------------------------------------
# trap setup helper for scenarios
# ---------------------------------------------------------------------------
harness::install_cleanup_trap() {
    trap 'harness::_kill_bg' EXIT
}
