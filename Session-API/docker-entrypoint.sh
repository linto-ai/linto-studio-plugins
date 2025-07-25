#!/bin/bash
set -e

echo "Waiting mqtt server..."
echo " $BROKER_HOST:$BROKER_PORT "
/wait-for-it.sh $BROKER_HOST:$BROKER_PORT --timeout=20 -s -- echo " $BROKER_HOST:$BROKER_PORT is up"

echo "Waiting database server..."
echo " $DB_HOST:$DB_PORT "
/wait-for-it.sh $DB_HOST:$DB_PORT --timeout=20 -s -- echo " $DB_HOST:$DB_PORT is up"

# Set default UID and GID (defaults to www-data: 33:33 if not specified)
USER_ID=${USER_ID:-33}
GROUP_ID=${GROUP_ID:-33}

# Default values for user and group names
USER_NAME="appuser"
GROUP_NAME="appgroup"

# Check and apply chown only if necessary
function safe_chown() {
    local target="$1"
    local user="$2"
    local group="$3"

    # Get the current uid and gid of the target
    local cur_uid
    local cur_gid
    cur_uid=$(stat -c "%u" "$target")
    cur_gid=$(stat -c "%g" "$target")

    # Get the target uid and gid
    local wanted_uid
    local wanted_gid
    wanted_uid=$(id -u "$user")
    wanted_gid=$(getent group "$group" | cut -d: -f3)

    # Do nothing if already owned by the target user and group
    if [[ "$cur_uid" == "$wanted_uid" && "$cur_gid" == "$wanted_gid" ]]; then
        echo "$target already owned by $user:$group"
    else
        echo "chown -R $user:$group $target"
        chown -R "$user:$group" "$target"
    fi
}

# Check and apply chmod only if necessary
function safe_chmod() {
    local target="$1"
    local wanted_mode="$2"
    # Accepts mode in octal format (e.g., 700)
    local cur_mode
    cur_mode=$(stat -c "%a" "$target")
    if [[ "$cur_mode" == "$wanted_mode" ]]; then
        echo "$target already has permissions $wanted_mode"
    else
        echo "chmod -R $wanted_mode $target"
        chmod -R "$wanted_mode" "$target"
    fi
}

# Function to create a user/group if needed and adjust permissions
function setup_user() {
    echo "Configuring runtime user with UID=$USER_ID and GID=$GROUP_ID"

    # Check if a group with the specified GID already exists
    if getent group "$GROUP_ID" >/dev/null 2>&1; then
        GROUP_NAME=$(getent group "$GROUP_ID" | cut -d: -f1)
        echo "A group with GID=$GROUP_ID already exists: $GROUP_NAME"
    else
        # Create the group if it does not exist
        echo "Creating group with GID=$GROUP_ID"
        groupadd -g "$GROUP_ID" "$GROUP_NAME"
    fi

    # Check if a user with the specified UID already exists
    if id -u "$USER_ID" >/dev/null 2>&1; then
        USER_NAME=$(getent passwd "$USER_ID" | cut -d: -f1)
        echo "A user with UID=$USER_ID already exists: $USER_NAME"
    else
        # Create the user if it does not exist
        echo "Creating user with UID=$USER_ID and GID=$GROUP_ID"
        useradd -m -u "$USER_ID" -g "$GROUP_NAME" "$USER_NAME"
    fi

    # Adjust ownership of the application directories
    echo "Adjusting ownership of application directories"
    safe_chown "/usr/src/app" "$USER_NAME" "$GROUP_NAME"

    # Get the user's home directory from the system
    USER_HOME=$(getent passwd "$USER_NAME" | cut -d: -f6)

    # Ensure the home directory exists
    if [ ! -d "$USER_HOME" ]; then
        echo "Ensure home directory exists: $USER_HOME"
        mkdir -p "$USER_HOME"
    fi

    # Grant full permissions to the user on their home directory
    echo "Granting full permissions to $USER_NAME on $USER_HOME"
    safe_chown "$USER_HOME" "$USER_NAME" "$GROUP_NAME"
    safe_chmod "$USER_HOME" "744"
}

setup_user

echo "RUNNING : $1"
cd /usr/src/app/sessionapi

eval "gosu $USER_NAME $1"
