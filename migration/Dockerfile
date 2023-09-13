FROM node:20

COPY migration/ /usr/src/app/migration
RUN cd /usr/src/app/migration && npm install

COPY wait-for-it.sh /
COPY migration/docker-entrypoint.sh /

ENTRYPOINT ["/docker-entrypoint.sh"]
WORKDIR /usr/src/app/migration

CMD ["npm run migrate"]
