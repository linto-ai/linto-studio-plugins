ARG default_image=node:22-alpine
FROM $default_image

RUN apk upgrade --no-cache && apk add --no-cache \
  bash \
  su-exec \
  shadow \
  curl \
  && ln -s /sbin/su-exec /usr/local/bin/gosu

COPY lib/ /usr/src/app/lib
COPY .envdefault /usr/src/app/
COPY Session-API/ /usr/src/app/sessionapi

RUN cd /usr/src/app/lib && npm install
RUN cd /usr/src/app/sessionapi && npm install && npm cache clean --force

COPY wait-for-it.sh /
COPY Session-API/docker-entrypoint.sh /

WORKDIR /usr/src/app/sessionapi
HEALTHCHECK --interval=60s --timeout=3s --start-period=30s CMD ./healthcheck.sh
ENTRYPOINT ["/docker-entrypoint.sh"]

CMD ["npm start"]
