FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production AGENTOS_HOST=0.0.0.0 AGENTOS_PORT=8080
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --fetch-timeout=30000 --fetch-retries=1 && npm cache clean --force
COPY build ./build
COPY dist ./dist
USER node
EXPOSE 8080 9090
CMD ["node", "build/server/platform/main.js"]
