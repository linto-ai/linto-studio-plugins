mosquitto_sub -h $BROKER_HOST -p $BROKER_PORT -t teams-scheduler/status -C 1 | grep '"online":true' || exit 1
