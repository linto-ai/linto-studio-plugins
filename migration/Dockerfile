ARG default_image=registry.fpfis.eu/scic/open-source-speech-to-text/source/node:20-alpine
#non code.europe.eu
FROM $default_image
#end non code.europe.eu

RUN apk add --no-cache libstdc++ dumb-init curl bash 
COPY migration/ /usr/src/app/migration
RUN cd /usr/src/app/migration && npm install &&  npm cache clean --force

COPY wait-for-it.sh /
COPY migration/docker-entrypoint.sh /

ENTRYPOINT ["/docker-entrypoint.sh"]
WORKDIR /usr/src/app/migration
RUN  cd /usr/src/app ; chown -R node:node ./
USER node
CMD ["npm run migrate"]
