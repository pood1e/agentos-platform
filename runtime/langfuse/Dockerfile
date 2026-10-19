FROM langfuse/langfuse:4.62.0@sha256:b40241743c639226a4bcba90e8a4d7bcb3335bd9947f84034c99dd85e60580a2
USER 0
COPY shared-session.cjs patch-session.cjs upstream.json /tmp/langfuse-session/
RUN node /tmp/langfuse-session/patch-session.cjs && rm -rf /tmp/langfuse-session
USER 1001
