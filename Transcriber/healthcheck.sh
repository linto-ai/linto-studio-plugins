nc -w 1 localhost $STREAMING_HEALTHCHECK_TCP | grep -q 'OK' || exit 1
