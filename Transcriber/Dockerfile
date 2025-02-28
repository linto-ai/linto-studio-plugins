ARG default_image=node:20-alpine
FROM $default_image AS build

RUN apk update && \
    apk add --no-cache \
        build-base \
        gstreamer \
        gstreamer-tools \
        gstreamer-dev \
        gst-plugins-base \
        gst-plugins-base-dev \
        gst-libav \
        meson \
        ninja \
        pkgconfig \
        git \
        cmake \
        tcl \
        autoconf \
        automake \
        python3 \
        py3-pip \
        python3-dev \
        py3-setuptools \
        openssl-dev

# Copier et installer les dépendances npm pour lib
COPY lib/ /usr/src/app/lib
RUN cd /usr/src/app/lib && npm install

# Copier et installer les dépendances npm pour transcriber
COPY Transcriber/ /usr/src/app/transcriber
RUN cd /usr/src/app/transcriber && npm install

# Étape finale
FROM $default_image
# Installer les dépendances d'exécution seulement
# we need gst-plugins-bad for MPEG2 codec
RUN apk update && \
    apk add --no-cache \
        ffmpeg \
        gstreamer \
        gstreamer-tools \
        gst-plugins-base \
        gst-plugins-bad \
        gst-plugins-good \
        gst-libav \
        shadow \
        chromium && \
    apk add --no-cache --repository="https://dl-cdn.alpinelinux.org/alpine/edge/testing" gosu

# Copier seulement les fichiers nécessaires depuis l'image de build
COPY --from=build /usr/src/app/lib /usr/src/app/lib
COPY --from=build /usr/src/app/transcriber /usr/src/app/transcriber

COPY .envdefault /usr/src/app/
COPY wait-for-it.sh /
COPY Transcriber/docker-entrypoint.sh /

WORKDIR /usr/src/app/transcriber

HEALTHCHECK --interval=60s --timeout=3s --start-period=30s CMD ./healthcheck.sh
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["npm start"]
