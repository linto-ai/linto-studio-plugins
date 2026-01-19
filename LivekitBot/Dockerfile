ARG default_image=node:20-bookworm
FROM $default_image

RUN apt-get update && apt-get install -y \
        gosu \
        python3 \
        make \
        g++ \
        # Dependencies for node-canvas
        libcairo2-dev \
        libpango1.0-dev \
        libjpeg-dev \
        libgif-dev \
        librsvg2-dev \
    && rm -rf /var/lib/apt/lists/*

COPY lib/ /usr/src/app/lib
COPY LivekitBot/ /usr/src/app/livekitbot
COPY .envdefault /usr/src/app/

RUN cd /usr/src/app/lib && npm install
RUN cd /usr/src/app/livekitbot && npm install && npm cache clean --force

COPY wait-for-it.sh /
COPY LivekitBot/docker-entrypoint.sh /

WORKDIR /usr/src/app/livekitbot

ENV NODE_ENV=production
ENV LIVEKITBOT_COMPONENTS=BrokerClient

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["npm", "start"]
