ARG default_image=node:22-bookworm
FROM $default_image

RUN apt-get update && apt-get install -y --no-install-recommends gosu curl \
    && rm -rf /var/lib/apt/lists/*

COPY lib/ /usr/src/app/lib
COPY .envdefault /usr/src/app/
COPY TeamsAppService/ /usr/src/app/teamsappservice

RUN cd /usr/src/app/lib && npm install
RUN cd /usr/src/app/teamsappservice && npm install && npm cache clean --force

COPY wait-for-it.sh /wait-for-it.sh
COPY TeamsAppService/docker-entrypoint.sh /docker-entrypoint.sh
COPY TeamsAppService/healthcheck.sh /healthcheck.sh
RUN chmod +x /wait-for-it.sh /docker-entrypoint.sh /healthcheck.sh

WORKDIR /usr/src/app/teamsappservice

# Expose HTTPS port
EXPOSE 443

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD /healthcheck.sh

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["npm start"]
