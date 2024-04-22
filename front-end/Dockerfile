ARG default_image=registry.fpfis.eu/scic/open-source-speech-to-text/source/node:20-ubuntu
#non code.europe.eu
FROM $default_image as build
#end non code.europe.eu

RUN apt-get update && \
    apt-get install -y gettext-base moreutils apache2-utils nginx && \
    rm /etc/nginx/sites-enabled/default

COPY front-end/nginx.conf /etc/nginx/sites-enabled/frontend.nginx.conf
COPY front-end/ /usr/src/app/front-end

RUN cd /usr/src/app/front-end && npm install

COPY front-end/docker-entrypoint.sh /

WORKDIR /usr/src/app/front-end
RUN  cd /usr/src/app ; chown -R node:node ./
HEALTHCHECK --interval=60s --timeout=3s --start-period=30s CMD ./healthcheck.sh
ENTRYPOINT ["/docker-entrypoint.sh"]

CMD ["nginx -g \"daemon off;\""]
