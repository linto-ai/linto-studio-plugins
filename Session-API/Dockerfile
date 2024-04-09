FROM node:20

COPY lib/ /usr/src/app/lib
COPY .envdefault /usr/src/app/
COPY Session-API/ /usr/src/app/sessionapi

RUN cd /usr/src/app/lib && npm install
RUN cd /usr/src/app/sessionapi && npm install

COPY wait-for-it.sh /
COPY Session-API/docker-entrypoint.sh /

WORKDIR /usr/src/app/sessionapi
RUN  cd /usr/src/app ; chown -R node:node ./ .envdefault
USER node
HEALTHCHECK --interval=60s --timeout=3s --start-period=30s CMD ./healthcheck.sh
ENTRYPOINT ["/docker-entrypoint.sh"]

CMD ["npm start"]
