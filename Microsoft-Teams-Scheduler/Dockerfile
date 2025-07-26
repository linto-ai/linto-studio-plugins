ARG default_image=node:20-bookworm
FROM $default_image

RUN apt-get update && apt-get install -y --no-install-recommends gosu mosquitto-clients \
    && rm -rf /var/lib/apt/lists/*

COPY lib/ /usr/src/app/lib
COPY .envdefault /usr/src/app/
COPY Microsoft-Teams-Scheduler/ /usr/src/app/msteams-scheduler

RUN cd /usr/src/app/lib && npm install
RUN cd /usr/src/app/msteams-scheduler && npm install && npm cache clean --force

COPY wait-for-it.sh /
COPY Microsoft-Teams-Scheduler/docker-entrypoint.sh /

WORKDIR /usr/src/app/msteams-scheduler
HEALTHCHECK --interval=60s --timeout=3s --start-period=30s CMD ./healthcheck.sh
ENTRYPOINT ["/docker-entrypoint.sh"]

CMD ["npm start"]
