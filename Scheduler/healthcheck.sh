mosquitto_sub -h $BROKER_HOST -p $BROKER_PORT -t scheduler/status -C 1 | grep '"online":true'
curl --fail http://localhost:$SCHEDULER_WEBSERVER_HTTP_PORT/healthcheck || exit 1
