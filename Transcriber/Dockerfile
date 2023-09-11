FROM node:20

RUN apt-get update && \
    apt-get install -y \
        build-essential \
        libgstreamer-plugins-base1.0-dev \
        gstreamer1.0-tools \
        libgstreamer1.0-dev \
        libsrt1.5-gnutls \
        srt-tools \
        libsrt-gnutls-dev \
        libssl-dev \
        gstreamer1.0-plugins \
        gstreamer1.0-plugins-base \
        gstreamer1.0-plugins-bad \
        gstreamer1.0-plugins-good \
        gstreamer1.0-libav

COPY lib/ /usr/src/app/lib
COPY .envdefault /usr/src/app/
COPY Transcriber/ /usr/src/app/transcriber

WORKDIR /usr/src/app/lib
RUN npm install

WORKDIR /usr/src/app/transcriber
RUN npm install

COPY wait-for-it.sh /
COPY Transcriber/docker-entrypoint.sh /
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["npm start"]