#!/usr/bin/env bash

# To launch the test, you must create a file named .envtest with the following content:
#
# DB_USER=myuser
# DB_PASSWORD=mypass
# DB_NAME=mydb
# DB_PORT=5433
# STREAMING_PASSPHRASE=testpassphrasemandatory
# STREAMING_USE_PROXY=false
# STREAMING_PROXY_HOST=127.0.0.1
# SESSION_API_HOST=http://localhost
# BROKER_PORT=1883
# SESSION_API_WEBSERVER_HTTP_PORT=8002
# TRANSCRIBER_REPLICAS=2

# This script test from end to end the service
# To start this test, the following env var must be set

source .envtest

generic_request() {
    local method=$1
    local url=$2
    local payload=$3

    local response=$(curl -s -w "\n%{http_code}" -X "$method" -H "Content-Type: application/json" ${payload:+-d "$payload"} "$url")
    local http_code=$(tail -n1 <<< "$response")
    local body=$(sed '$ d' <<< "$response")

    if [ "$http_code" -eq 200 ]; then
        if jq -e . >/dev/null 2>&1 <<<"$body"; then
            echo "$body"
        else
            echo "Error: not a valid JSON"
            return 2
        fi
    else
        echo "Error: HTTP code $http_code"
        return 1
    fi
}

post_request() { generic_request POST "$@"; }
put_request()  { generic_request PUT "$@";  }
get_request()  { generic_request GET "$@";  }

check_response() {
    local response=$1
    local check_expr=$2
    local success_msg=$3
    local error_msg=$4

    if eval "$check_expr"; then
        echo "$success_msg"
    else
        echo "$error_msg: $response"
    fi
}

## ---------------------
## PAYLOADS
TRANSCRIBER_PROFILE_CREATE_PAYLOAD=$(
  cat <<EOF
{
  "config": {
    "type": "microsoft",
    "name": "microsoft_custom_fr",
    "description": "microsoft custom fr",
    "languages": [
      {
        "candidate": "fr-FR",
        "endpoint": "$ASR_ENDPOINT"
      }
    ],
    "key": "$ASR_API_KEY",
    "region": "$ASR_REGION",
    "endpoint": "$ASR_ENDPOINT"
  }
}
EOF
)

SESSION_CREATE_PAYLOAD=$(
  cat <<EOF
{
  "name": "test_session",
  "channels": [
    {
      "name": "test_channel",
      "transcriberProfileId": 1
    }
  ]
}
EOF
)

TRANSCRIBER_PROFILE_URL="http://localhost/sessionapi/v1/transcriber_profiles"
SESSION_URL="http://localhost/sessionapi/v1/sessions"

## ---------------------
## END PAYLOADS


## ---------------------
## Start the env
echo "Start the service"
docker compose --env-file .envtest -f compose.yml -f compose.test.yml down --volumes
docker compose --env-file .envtest -f compose.yml -f compose.test.yml up --build -d

while ! curl -s -o /dev/null -w "%{http_code}" $TRANSCRIBER_PROFILE_URL | grep -q 200; do
    echo "Waiting for containers..."
    sleep 5
done

## ---------------------
## Test Transcriber Profile
echo "- Checking Transcriber Profile"
response=$(post_request "$TRANSCRIBER_PROFILE_URL" "$TRANSCRIBER_PROFILE_CREATE_PAYLOAD")
check_response "$response" '[ $? -eq 0 ]' "POST OK" "Error when creating Transcriber profile: $response"

response=$(get_request "$TRANSCRIBER_PROFILE_URL")
check_response "$response" '[[ $(echo "$response" | jq length) -gt 0 ]] && [[ $(echo "$response" | jq -r '.[0].config.name') == "microsoft_custom_fr" ]]' "GET OK" "Error: Transcriber Profile not created"


### ---------------------
### Test Session
echo "- Checking Session"
response=$(post_request "$SESSION_URL" "$SESSION_CREATE_PAYLOAD")
check_response "$response" '[ $? -eq 0 ]' "POST OK" "Error when creating Session: $response"

response=$(get_request "$SESSION_URL")
check_response "$response" "[[ $(echo $response | jq '.totalItems') -eq 1 ]] && [[ $(echo $response | jq -r '.sessions[0].name') == 'test_session' ]]" "GET OK" "Error: Session not created"

SESSION_ID="$(echo "$response" | jq -r '.sessions[0].id')"

### ---------------------
### Test Session Ready
echo "- Checking Session ready"
response=$(get_request "$SESSION_URL/$SESSION_ID")
check_response "$response" "[[ $(echo $response | jq -r '.status') == 'ready' ]]" "GET ACTIVE OK" "Error: Session not created"

### ---------------------
### Test Transcriber crash
# TODO: Should the channel streamStatus set to errored when the transcriber crash ?
echo "- Checking Transcriber crash"
docker stop transcriber-integration-test
sleep 5
response=$(get_request "$SESSION_URL/$SESSION_ID")
#check_response "$response" "[[ $(echo $response | jq -r '.channels[0].transcriber_status') == 'errored' ]]" "Transcriber status errored in DB: OK" "Error: Transcriber status not errored in DB"

### ---------------------
### Test Transcriber recover
echo "- Checking Transcriber recovering"
docker start transcriber-integration-test
sleep 20
response=$(get_request "$SESSION_URL/$SESSION_ID")
#check_response "$response" "[[ $(echo $response | jq -r '.channels[0].transcriber_status') == 'ready' ]]" "Transcriber status ready in DB: OK" "Error: Transcriber status not ready in DB"

STREAM_ENDPOINT="$(echo "$response" | jq -r '.channels[0].streamEndpoints["srt"]')"
echo "$response STREAM_ENPOINT= $STREAM_ENDPOINT"

### ---------------------
### Test send stream
echo "- Checking Streaming and Transcription"
response=$(get_request "$SESSION_URL/$SESSION_ID")
check_response "$response" "[[ $(echo $response | jq -r '.channels[0].closedCaptions | length == 0') ]]" "Channel transcription empty OK" "Error: Channel transcription not empty"

gst-launch-1.0 filesrc location=./fr.mp3 ! decodebin ! audioconvert ! audioresample ! avenc_ac3 ! mpegtsmux ! rtpmp2tpay ! srtsink uri="$STREAM_ENDPOINT" &

# streaming status active
sleep 3
response=$(get_request "$SESSION_URL/$SESSION_ID")
check_response "$response" "[[ $(echo $response | jq -r '.channels[0].streamStatus') == 'active' ]]" "Transcriber status streaming in DB: OK" "Error: Transcriber status not streaming in DB"

wait

check_response "$response" "[[ $(echo "$response" | jq -r '.channels[0].closedCaptions | length > 0') ]]" "Channel transcription full OK" "Error: Channel transcription is empty"
sleep 2

### ---------------------
### Test Session Stop
echo "- Checking Session stop"
response=$(put_request "$SESSION_URL/$SESSION_ID/stop")
check_response "$response" '[ $? -eq 0 ]' "PUT OK" "Error when stopping Session: $response"
sleep 3
response=$(get_request "$SESSION_URL/$SESSION_ID")
check_response "$response" "[[ $(echo $response | jq -r '.status') == 'terminated' ]]" "Transcriber status ready in DB: OK" "Error: Transcriber status not ready in DB"

## Stop the env
docker compose --env-file .envtest -f compose.yml -f compose.test.yml down --volumes
