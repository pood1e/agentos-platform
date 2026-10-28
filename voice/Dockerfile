FROM python:3.13.15-slim@sha256:7c61056e61ac89e852de05f3dc6fa51a6dd2181797bceed46aa725dd7cb2cd3b AS dependencies
WORKDIR /build
COPY requirements.lock ./
RUN pip install --no-cache-dir --require-hashes -r requirements.lock --target /dependencies
COPY agentos_contracts-*.whl ./
RUN pip install --no-cache-dir --no-deps ./*.whl --target /dependencies

FROM python:3.13.15-slim@sha256:7c61056e61ac89e852de05f3dc6fa51a6dd2181797bceed46aa725dd7cb2cd3b
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 HOME=/tmp XDG_CACHE_HOME=/tmp/cache
COPY --from=dependencies /dependencies/ /usr/local/lib/python3.13/site-packages/
COPY --chown=1000:1000 agentos_voice/ /app/agentos_voice/
WORKDIR /app
USER 1000:1000
ENTRYPOINT ["python", "-m", "livekit.agents", "start", "agentos_voice/worker.py", "--log-level", "WARNING"]
