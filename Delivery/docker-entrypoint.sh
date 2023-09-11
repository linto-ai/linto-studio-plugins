#!/bin/bash
set -e

echo "Waiting mqtt server..."
echo " $BROKER_HOST:$BROKER_PORT "
/wait-for-it.sh $BROKER_HOST:$BROKER_PORT --timeout=5 -s -- echo " $BROKER_HOST:$BROKER_PORT is up"

echo "RUNNING : $1"
cd /usr/src/app/delivery

eval "$1"