# Build context = the linto-studio-plugins repo ROOT so this image builds like the
# other modules once wired into CI (Jenkinsfile buildAllPlugins / staging stage):
#   docker build -f VisioBotService/Dockerfile .
# Two-stage on python:3.12-slim (matches TranslatorPython + the interpreter the
# code is developed/tested on); deps are the exact set pinned in pyproject/uv.lock.
FROM python:3.12-slim AS builder

WORKDIR /build
COPY VisioBotService/pyproject.toml .
COPY VisioBotService/visio_bot_service.py .
COPY VisioBotService/components/ components/
COPY VisioBotService/bot/ bot/
RUN pip install --no-cache-dir --prefix=/install .

FROM python:3.12-slim

# Drop root: broker-only service (LiveKit + MQTT), no writable mount, no Chromium.
RUN groupadd -r visiobot && useradd -r -g visiobot -s /sbin/nologin visiobot

COPY --from=builder /install /usr/local
COPY VisioBotService/visio_bot_service.py /app/visio_bot_service.py
COPY VisioBotService/components/ /app/components/
COPY VisioBotService/bot/ /app/bot/
COPY VisioBotService/.envdefault /app/.envdefault

WORKDIR /app

USER visiobot

EXPOSE 8081
# Honour VISIOBOT_HEALTHCHECK_HTTP (the port the Healthcheck component binds) so
# an override does not silently break the probe.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD python -c "import os,urllib.request,sys; p=os.environ.get('VISIOBOT_HEALTHCHECK_HTTP','8081'); sys.exit(0 if urllib.request.urlopen(f'http://127.0.0.1:{p}/healthcheck', timeout=2).status==200 else 1)"

CMD ["python", "visio_bot_service.py"]
