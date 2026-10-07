# Build this trusted tooling image separately, never a generated Dockerfile.
FROM node:22-bookworm-slim
LABEL forgeweb.worker.contract="forgeweb-docker-worker-v1"
# TypeScript's node_modules/.tmp cache must stay in the isolated writable tmpfs.
RUN apt-get update && apt-get install -y --no-install-recommends postgresql ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /opt/forgeweb /workspace /opt/frontend/node_modules \
    && ln -s /tmp /opt/frontend/node_modules/.tmp
COPY worker.mjs /opt/forgeweb/worker.mjs
USER 1000:1000
ENV HOME=/tmp NODE_ENV=test CI=true
WORKDIR /tmp
ENTRYPOINT ["node", "/opt/forgeweb/worker.mjs"]
