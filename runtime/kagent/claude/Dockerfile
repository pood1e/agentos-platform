FROM ghcr.io/kagent-dev/kagent/claude-harness:1.0.0-alpha17@sha256:69cbd021825de5b6798723c96a4ae72f78a4916e70e4f1cd7f6bd5678e6641ff
USER 0:0
COPY --chmod=0755 install.sh /tmp/install-toolbox.sh
RUN /tmp/install-toolbox.sh && rm /tmp/install-toolbox.sh
COPY kagent-claude /usr/local/bin/kagent-claude
USER 65532:65532
ENV HOME=/data
RUN python --version && curl --version && jq --version && ssh -V
LABEL org.opencontainers.image.source="https://github.com/pood1e/agentos-platform" \
      org.opencontainers.image.version="1.0.0-alpha17-agentos.4"
