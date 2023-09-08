#!/bin/bash
set -e

echo "Waiting mqtt server..."
echo " $BROKER_HOST:$BROKER_PORT "
/wait-for-it.sh $BROKER_HOST:$BROKER_PORT --timeout=20 -s -- echo " $BROKER_HOST:$BROKER_PORT is up"

echo "Waiting database server..."
echo " $DB_HOST:$DB_PORT "
/wait-for-it.sh $DB_HOST:$DB_PORT --timeout=20 -s -- echo " $DB_HOST:$DB_PORT is up"


echo "RUNNING : $1"
cd /usr/src/app/scheduler

eval "$1"