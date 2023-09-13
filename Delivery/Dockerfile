FROM node:20

COPY lib/ /usr/src/app/lib
COPY .envdefault /usr/src/app/
COPY Delivery/ /usr/src/app/delivery

RUN cd /usr/src/app/lib && npm install
RUN cd /usr/src/app/delivery && npm install

COPY wait-for-it.sh /
COPY Delivery/docker-entrypoint.sh /

WORKDIR /usr/src/app/delivery
HEALTHCHECK --interval=60s --timeout=3s --start-period=30s CMD ./healthcheck.sh
ENTRYPOINT ["/docker-entrypoint.sh"]

CMD ["npm start"]
