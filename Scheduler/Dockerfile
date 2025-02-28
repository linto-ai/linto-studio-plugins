ARG default_image=node:20-alpine3.19
FROM $default_image
RUN apk update && \
    apk add --no-cache libstdc++ dumb-init curl bash mosquitto-clients shadow && \
    apk add --no-cache --repository="https://dl-cdn.alpinelinux.org/alpine/edge/testing" gosu

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
