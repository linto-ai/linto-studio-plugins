ARG default_image=node:22-alpine
FROM $default_image

RUN apk upgrade --no-cache && apk add --no-cache \
  bash \
  su-exec \
  shadow \
  && ln -s /sbin/su-exec /usr/local/bin/gosu

COPY migration/ /usr/src/app/migration
RUN cd /usr/src/app/migration && npm install && npm cache clean --force

COPY wait-for-it.sh /
COPY migration/docker-entrypoint.sh /

ENTRYPOINT ["/docker-entrypoint.sh"]
WORKDIR /usr/src/app/migration
CMD ["npm run migrate"]
