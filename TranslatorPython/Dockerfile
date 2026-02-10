FROM python:3.12-slim AS builder

WORKDIR /build
COPY pyproject.toml .
COPY translator/ translator/
RUN pip install --no-cache-dir --prefix=/install .

FROM python:3.12-slim

RUN groupadd -r translator && useradd -r -g translator -s /sbin/nologin translator

COPY --from=builder /install /usr/local
COPY translator/ /app/translator/
COPY .envdefault /app/

WORKDIR /app

USER translator

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
    CMD python -c "import os; os.kill(1, 0)" || exit 1

CMD ["python", "-m", "translator.main"]
