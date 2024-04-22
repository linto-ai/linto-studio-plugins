ARG default_image=registry.fpfis.eu/scic/open-source-speech-to-text/source/node:20-alpine
#non code.europe.eu
FROM $default_image
#end non code.europe.eu

RUN apk add --no-cache libstdc++ dumb-init curl bash 
COPY lib/ /usr/src/app/lib
COPY .envdefault /usr/src/app/
COPY Session-API/ /usr/src/app/sessionapi

RUN cd /usr/src/app/lib && npm install
RUN cd /usr/src/app/sessionapi && npm install && npm cache clean --force  

COPY wait-for-it.sh /
COPY Session-API/docker-entrypoint.sh /

WORKDIR /usr/src/app/sessionapi
RUN  cd /usr/src/app ; chown -R node:node ./ .envdefault
USER node
HEALTHCHECK --interval=60s --timeout=3s --start-period=30s CMD ./healthcheck.sh
ENTRYPOINT ["/docker-entrypoint.sh"]

CMD ["npm start"]
