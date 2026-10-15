ARG HARNESS_IMAGE
FROM ${HARNESS_IMAGE}
USER 0:0
COPY --chmod=0755 install.sh /tmp/install-toolbox.sh
RUN /tmp/install-toolbox.sh && rm /tmp/install-toolbox.sh
USER 65532:65532
ENV HOME=/data
RUN python --version && curl --version && jq --version && ssh -V
