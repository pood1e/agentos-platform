FROM ghcr.io/jdx/mise:2026.10.18@sha256:fc31de7b93d195613deb600d42c65a164b0205716ade38132aadeabac3838248 AS mise
FROM mcr.microsoft.com/playwright:v1.64.0-noble@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential ca-certificates git openssh-client postgresql-client \
    && rm -rf /var/lib/apt/lists/*
COPY --from=mise /usr/local/bin/mise /usr/local/bin/mise
ENV MISE_DATA_DIR=/opt/mise MISE_CACHE_DIR=/tmp/mise-cache \
    MISE_GLOBAL_CONFIG_FILE=/opt/agentos-ci/mise.toml \
    MISE_TRUSTED_CONFIG_PATHS=/opt/agentos-ci:/builds \
    ANSIBLE_COLLECTIONS_PATH=/opt/agentos-ci/collections \
    KUBEBUILDER_ASSETS=/usr/local/kubebuilder/bin \
    PATH=/opt/agentos-ci/venv/bin:/opt/mise/shims:$PATH
WORKDIR /opt/agentos-ci
COPY mise.toml mise.lock ./
RUN mise install --locked && mise reshim && rm -rf /root/go /root/.cache /tmp/mise-cache
COPY ci/ ci/
COPY deploy/requirements.txt deploy/requirements.yaml deploy/
COPY contracts/requirements.txt contracts/
COPY automation/requirements.in automation/
RUN uv venv /opt/agentos-ci/venv --python 3.15.0 \
    && uv pip install --python /opt/agentos-ci/venv/bin/python \
       -r ci/python-requirements.txt -r deploy/requirements.txt -r contracts/requirements.txt \
    && ansible-galaxy collection install -r deploy/requirements.yaml -p /opt/agentos-ci/collections \
    && uv cache clean
RUN assets="$(setup-envtest use 1.37 --bin-dir /tmp/envtest -p path)" \
    && mkdir -p /usr/local/kubebuilder/bin \
    && cp "$assets/"* /usr/local/kubebuilder/bin/ \
    && rm -rf /tmp/envtest
WORKDIR /builds
