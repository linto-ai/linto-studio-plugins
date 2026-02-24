ARG default_image=node:22-alpine
FROM $default_image

RUN apk upgrade --no-cache && apk add --no-cache \
  bash \
  su-exec \
  shadow \
  mosquitto-clients \
  && ln -s /sbin/su-exec /usr/local/bin/gosu

COPY lib/ /usr/src/app/lib
COPY .envdefault /usr/src/app/
COPY Scheduler/ /usr/src/app/scheduler

RUN cd /usr/src/app/lib && npm install
RUN cd /usr/src/app/scheduler && npm install && npm cache clean --force

COPY wait-for-it.sh /
COPY Scheduler/docker-entrypoint.sh /

WORKDIR /usr/src/app/scheduler
HEALTHCHECK --interval=60s --timeout=3s --start-period=30s CMD ./healthcheck.sh
ENTRYPOINT ["/docker-entrypoint.sh"]

CMD ["npm start"]
