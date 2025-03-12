ARG default_image=node:20-bookworm
#non code.europe.eu
FROM $default_image
#end non code.europe.eu

RUN apt-get update && apt-get install -y \
        gosu \
    && rm -rf /var/lib/apt/lists/*

COPY migration/ /usr/src/app/migration
RUN cd /usr/src/app/migration && npm install &&  npm cache clean --force

COPY wait-for-it.sh /
COPY migration/docker-entrypoint.sh /

ENTRYPOINT ["/docker-entrypoint.sh"]
WORKDIR /usr/src/app/migration
CMD ["npm run migrate"]
