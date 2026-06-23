# Debian base (bookworm): Playwright Chromium is not supported on Alpine, unlike
# the other Node services which run node:22-alpine.
ARG default_image=node:22-bookworm
FROM $default_image

RUN apt-get update && apt-get install -y --no-install-recommends gosu netcat-openbsd \
  && rm -rf /var/lib/apt/lists/*

COPY lib/ /usr/src/app/lib
COPY .envdefault /usr/src/app/
RUN cd /usr/src/app/lib && npm ci

# Install JS deps + Playwright Chromium FIRST (keyed only on the lockfiles) so a
# source-only change does not re-download the browser. Copy the app code after.
COPY BotService/package.json BotService/package-lock.json /usr/src/app/botservice/
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers
RUN cd /usr/src/app/botservice && npm ci \
  && npx playwright install --with-deps chromium \
  && chmod -R 755 /opt/playwright-browsers \
  && npm cache clean --force

COPY BotService/ /usr/src/app/botservice

COPY wait-for-it.sh /
COPY BotService/docker-entrypoint.sh /

WORKDIR /usr/src/app/botservice
HEALTHCHECK --interval=60s --timeout=3s --start-period=30s CMD ./healthcheck.sh
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["npm start"]
