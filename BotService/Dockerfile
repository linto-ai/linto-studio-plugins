ARG default_image=node:20-bookworm
FROM $default_image

RUN apt-get update && apt-get install -y \
        gosu \
        autoconf \
        automake \
        tcl \
        cmake \
        libtool \
        build-essential \
        ffmpeg \
        libsrt1.5-gnutls \
        srt-tools \
        libsrt-gnutls-dev \
        libssl-dev \
        netcat-openbsd \
        # Chrome/Chromium dependencies \
        libnss3 \
        libnspr4 \
        libatk1.0-0 \
        libatk-bridge2.0-0 \
        libcups2 \
        libdrm2 \
        libxkbcommon0 \
        libxcomposite1 \
        libxdamage1 \
        libxrandr2 \
        libgbm1 \
        libxss1 \
        libasound2 \
        libatspi2.0-0 \
        libgtk-3-0 \
        libgdk-pixbuf2.0-0 \
    && rm -rf /var/lib/apt/lists/*

RUN wget -O /tmp/chromium.tar.xz https://dl.linto.ai/downloads/tools/ungoogled-chromium_135.0.7049.84-1_linux.tar.xz && \
    mkdir -p /opt/chrome && \
    tar -xf /tmp/chromium.tar.xz -C /opt/chrome --strip-components=1 && \
    rm /tmp/chromium.tar.xz

COPY lib/ /usr/src/app/lib
COPY BotService/ /usr/src/app/botservice
COPY .envdefault /usr/src/app/

RUN cd /usr/src/app/lib && npm install
RUN cd /usr/src/app/botservice && npm install && npm cache clean --force

COPY wait-for-it.sh /
COPY BotService/docker-entrypoint.sh /

WORKDIR /usr/src/app/botservice
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["npm", "start"]
