FROM node:20

WORKDIR /usr/src/app/migration
COPY migration/ /usr/src/app/migration
RUN npm install

COPY wait-for-it.sh /
COPY migration/docker-entrypoint.sh /
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["npm run migrate"]
