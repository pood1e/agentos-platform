FROM python:3.15-slim@sha256:2da676046630d7bf14c6764ae1143dc7fa0377a53f94bf5a642f0b214aca5bce AS dependencies
WORKDIR /build
COPY requirements.lock ./
RUN pip install --no-cache-dir --require-hashes -r requirements.lock --target /dependencies
COPY agentos_contracts-*.whl ./
RUN pip install --no-cache-dir --no-deps ./*.whl --target /dependencies

FROM python:3.15-slim@sha256:2da676046630d7bf14c6764ae1143dc7fa0377a53f94bf5a642f0b214aca5bce
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
COPY --from=dependencies /dependencies/ /usr/local/lib/python3.15/site-packages/
COPY --chown=1000:1000 agentos_automation/ /app/agentos_automation/
WORKDIR /app
USER 1000:1000
ENTRYPOINT ["python", "-m", "agentos_automation"]
