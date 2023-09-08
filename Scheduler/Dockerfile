FROM node:20

COPY lib/ /usr/src/app/lib
COPY .envdefault /usr/src/app/
WORKDIR /usr/src/app/scheduler
COPY Scheduler/ /usr/src/app/scheduler

RUN cd /usr/src/app/lib && npm install
RUN npm install

COPY wait-for-it.sh /
COPY Scheduler/docker-entrypoint.sh /
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["npm start"]