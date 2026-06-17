# Slim image — the live path uses plain HTTP (no browser needed).
# To enable the optional Playwright rediscovery fallback, switch the base to
# mcr.microsoft.com/playwright/python:v1.49.1 and run `playwright install chromium`.
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    H2HGGL_DB_PATH=/data/h2hgg.db

WORKDIR /srv

# Install runtime deps only (skip playwright/pytest for the slim image).
COPY requirements.txt .
RUN pip install \
      "fastapi==0.133.0" "uvicorn[standard]==0.34.0" "httpx==0.28.1" \
      "apscheduler==3.11.0" "pydantic==2.10.4"

COPY app ./app

RUN mkdir -p /data && \
    groupadd -r app && useradd -r -g app -d /srv -s /sbin/nologin app && \
    chown -R app:app /data /srv

USER app

VOLUME ["/data"]
EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
