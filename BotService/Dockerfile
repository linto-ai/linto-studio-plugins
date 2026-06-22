# Debian base (bookworm): Playwright Chromium is not supported on Alpine, unlike
# the other Node services which run node:22-alpine.
ARG default_image=node:22-bookworm
FROM $default_image

RUN apt-get update && apt-get install -y --no-install-recommends gosu \
  && rm -rf /var/lib/apt/lists/*

COPY lib/ /usr/src/app/lib
COPY .envdefault /usr/src/app/
COPY BotService/ /usr/src/app/botservice

RUN cd /usr/src/app/lib && npm ci

# Install JS deps, then the Playwright Chromium + its system libraries into a
# world-readable shared path so the dropped runtime user can launch it.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers
RUN cd /usr/src/app/botservice && npm ci \
  && npx playwright install-deps chromium \
  && chmod -R 755 /opt/playwright-browsers \
  && npm cache clean --force

COPY wait-for-it.sh /
COPY BotService/docker-entrypoint.sh /

WORKDIR /usr/src/app/botservice
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["npm start"]
