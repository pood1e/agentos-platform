FROM ghcr.io/kagent-dev/kagent/claude-harness:1.0.0-alpha11@sha256:bf6301a24e447ccd35ea82023f9d2c781332df712bea993195ddcb414ab848a0
USER 0:0
COPY --chmod=0755 install.sh /tmp/install-toolbox.sh
RUN /tmp/install-toolbox.sh && rm /tmp/install-toolbox.sh
COPY kagent-claude /usr/local/bin/kagent-claude
USER 65532:65532
ENV HOME=/data
RUN python --version && curl --version && jq --version && ssh -V
LABEL org.opencontainers.image.source="https://github.com/pood1e/agentos-platform" \
      org.opencontainers.image.version="1.0.0-alpha11-agentos.2"
