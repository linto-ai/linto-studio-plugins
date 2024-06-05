#!/bin/sh
set -e

#echo "Waiting mqtt server..."
#echo " $BROKER_HOST:$BROKER_PORT "
#/wait-for-it.sh $BROKER_HOST:$BROKER_PORT --timeout=20 -s -- echo " $BROKER_HOST:$BROKER_PORT is up"

echo "RUNNING : $1"
cd /usr/src/app/transcriber

eval "$1"
