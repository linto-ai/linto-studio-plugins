ARG default_image=node:20-alpine3.19
#non code.europe.eu
FROM $default_image
#end non code.europe.eu

RUN apk update && \
    apk add --no-cache libstdc++ dumb-init curl bash shadow && \
    apk add --no-cache --repository="https://dl-cdn.alpinelinux.org/alpine/edge/testing" gosu

COPY migration/ /usr/src/app/migration
RUN cd /usr/src/app/migration && npm install &&  npm cache clean --force

COPY wait-for-it.sh /
COPY migration/docker-entrypoint.sh /

ENTRYPOINT ["/docker-entrypoint.sh"]
WORKDIR /usr/src/app/migration
CMD ["npm run migrate"]
