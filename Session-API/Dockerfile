FROM node:20

COPY lib/ /usr/src/app/lib
COPY .envdefault /usr/src/app/
WORKDIR /usr/src/app/sessionapi
COPY Session-API/ /usr/src/app/sessionapi

RUN cd /usr/src/app/lib && npm install
RUN npm install

COPY wait-for-it.sh /
COPY Session-API/docker-entrypoint.sh /
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["npm start"]
