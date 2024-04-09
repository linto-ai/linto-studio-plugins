FROM node:20

RUN apt-get update && apt-get install -y mosquitto-clients

COPY lib/ /usr/src/app/lib
COPY .envdefault /usr/src/app/
COPY Scheduler/ /usr/src/app/scheduler

RUN cd /usr/src/app/lib && npm install
RUN cd /usr/src/app/scheduler && npm install

COPY wait-for-it.sh /
COPY Scheduler/docker-entrypoint.sh /

WORKDIR /usr/src/app/scheduler
RUN  cd /usr/src/app ; chown -R node:node ./ .envdefault
USER node
HEALTHCHECK --interval=60s --timeout=3s --start-period=30s CMD ./healthcheck.sh
ENTRYPOINT ["/docker-entrypoint.sh"]

CMD ["npm start"]
