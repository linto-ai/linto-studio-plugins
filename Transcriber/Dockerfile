ARG default_image=node:20-bookworm
FROM $default_image

# we need gst-plugins-bad for MPEG2 codec
RUN apt-get update && apt-get install -y \
        gosu \
        autoconf \
        automake \
        tcl \
        cmake \
        libtool \
        build-essential \
        ffmpeg \
        gstreamer1.0-tools \
        gstreamer1.0-plugins \
        gstreamer1.0-plugins-base \
        gstreamer1.0-plugins-bad \
        gstreamer1.0-plugins-good \
        gstreamer1.0-libav \
        libgstreamer-plugins-base1.0-dev \
        libgstreamer1.0-dev \
        libsrt1.5-gnutls \
        srt-tools \
        libsrt-gnutls-dev \
        libssl-dev \
        chromium \
        netcat-openbsd \
    && rm -rf /var/lib/apt/lists/*

COPY lib/ /usr/src/app/lib
COPY Transcriber/ /usr/src/app/transcriber
COPY .envdefault /usr/src/app/

RUN cd /usr/src/app/lib && npm install
RUN cd /usr/src/app/transcriber && npm install

COPY wait-for-it.sh /
COPY Transcriber/docker-entrypoint.sh /

WORKDIR /usr/src/app/transcriber

HEALTHCHECK --interval=60s --timeout=3s --start-period=30s CMD ./healthcheck.sh
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["npm start"]
