From node:20 as build

RUN apt-get update && \
    apt-get install -y gettext-base moreutils nginx && \
    rm /etc/nginx/sites-enabled/default

COPY front-end/nginx.conf /etc/nginx/sites-enabled/frontend.nginx.conf

COPY front-end/ /usr/src/app/front-end
RUN cd /usr/src/app/front-end && npm install

COPY front-end/docker-entrypoint.sh /

WORKDIR /usr/src/app/front-end
EXPOSE 80
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["nginx -g \"daemon off;\""]
