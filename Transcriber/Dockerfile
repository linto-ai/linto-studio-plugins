ARG default_image=node:20-alpine
FROM $default_image as build

RUN apk update && \
    apk add --no-cache \
        build-base \
        gstreamer \
        gstreamer-tools \
        gstreamer-dev \
        libsrt \
        libsrt-dev \
        libsrtp \
        libsrtp-dev \
        librtmp \
        openssl-dev \
        gst-plugins-base \
        gst-plugins-base-dev \
        gst-plugins-bad \
        gst-plugins-bad-dev \
        gst-plugins-good \
        gst-libav \
        meson \
        ninja \
        pkgconfig \
        git

# Cloner et compiler gst-plugins-bad avec le support SRT
RUN git clone https://gitlab.freedesktop.org/gstreamer/gst-plugins-bad.git /usr/src/gst-plugins-bad && \
    cd /usr/src/gst-plugins-bad && \
    meson build --prefix=/usr -Dpackage-origin=https://gstreamer.freedesktop.org/src/gst-plugins-bad/ -Dpackage-name="GStreamer Bad Plugins" -D srt=enabled -D srtp=enabled && \
    ninja -C build && \
    ninja -C build install

# Copier et installer les dépendances npm pour lib
COPY lib/ /usr/src/app/lib
RUN cd /usr/src/app/lib && npm install

# Copier et installer les dépendances npm pour transcriber
COPY Transcriber/ /usr/src/app/transcriber
RUN cd /usr/src/app/transcriber && npm install

# Étape finale
FROM $default_image

# Installer les dépendances d'exécution seulement
RUN apk update && \
    apk add --no-cache \
        gstreamer \
        gstreamer-tools \
        gst-plugins-base \
        gst-plugins-bad \
        gst-plugins-good \
        gst-libav

# Copier les plugins gst-plugins-bad compilés avec le support SRT
COPY --from=build /usr/lib/gstreamer-1.0/libgstsrt* /usr/lib/gstreamer-1.0/

# Copier seulement les fichiers nécessaires depuis l'image de build
COPY --from=build /usr/src/app/lib /usr/src/app/lib
COPY --from=build /usr/src/app/transcriber /usr/src/app/transcriber

COPY .envdefault /usr/src/app/
COPY wait-for-it.sh /
COPY Transcriber/docker-entrypoint.sh /

WORKDIR /usr/src/app/transcriber
RUN cd /usr/src/app ; chown -R node:node ./ .envdefault
USER node

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["npm start"]
