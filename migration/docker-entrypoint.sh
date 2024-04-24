#!/bin/bash
set -e

echo "Waiting database server..."
echo " $DB_HOST:$DB_PORT "
/wait-for-it.sh $DB_HOST:$DB_PORT --timeout=60 -s -- echo " $DB_HOST:$DB_PORT is up"


echo "RUNNING : $1"
cd /usr/src/app/migration

eval "$1"
