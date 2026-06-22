#!/bin/bash
set -e

# The BotService is broker-only: it never touches the database (session/channel
# data arrives in the MQTT startbot payload), so we only wait for the broker.
echo "Waiting mqtt server... $BROKER_HOST:$BROKER_PORT"
/wait-for-it.sh "$BROKER_HOST:$BROKER_PORT" --timeout=20 -s -- echo " $BROKER_HOST:$BROKER_PORT is up"

USER_ID=${USER_ID:-33}
GROUP_ID=${GROUP_ID:-33}
USER_NAME="appuser"
GROUP_NAME="appgroup"

function setup_user() {
    echo "Configuring runtime user UID=$USER_ID GID=$GROUP_ID"
    if getent group "$GROUP_ID" >/dev/null 2>&1; then
        GROUP_NAME=$(getent group "$GROUP_ID" | cut -d: -f1)
    else
        groupadd -g "$GROUP_ID" "$GROUP_NAME"
    fi
    if getent passwd "$USER_ID" >/dev/null 2>&1; then
        USER_NAME=$(getent passwd "$USER_ID" | cut -d: -f1)
    else
        useradd -m -u "$USER_ID" -g "$GROUP_NAME" "$USER_NAME"
    fi

    USER_HOME=$(getent passwd "$USER_NAME" | cut -d: -f6)
    [ -d "$USER_HOME" ] || mkdir -p "$USER_HOME"

    if [ "${DEVELOPMENT}" = "true" ]; then
        echo "Development mode: skipping ownership changes to preserve volume mounts"
    else
        # Adjust ownership of app dirs, excluding node_modules for performance.
        find /usr/src/app -maxdepth 1 ! -name node_modules -exec chown "$USER_NAME:$GROUP_NAME" {} \;
        chown "$USER_NAME:$GROUP_NAME" "$USER_HOME"
    fi
}

setup_user

echo "RUNNING : $1"
cd /usr/src/app/botservice
eval "gosu $USER_NAME $1"
