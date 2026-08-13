# Production image for the wdashboard client: a Bun bundle served as static files by nginx.
#
# Build from the REPO ROOT, not from client/:
#   docker build -f client/Dockerfile .
# The bundle pulls in src/ (the KLineChart Pro library itself), so the context has to span
# both directories.
FROM oven/bun:1.3.14 AS builder
WORKDIR /app

# --frozen-lockfile so an image build can never silently resolve a different dependency
# version than the one committed — the same reason the Python images use `uv sync --frozen`.
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
COPY client ./client

# The path the app is served under, baked into the emitted asset URLs. Must match the Helm
# release's `path` value: a root bundle's asset URLs 404 under a sub-path and vice versa.
ARG BASE_PATH=/
ENV BASE_PATH=${BASE_PATH}
RUN bun run scripts/build-client.ts

FROM nginx:1.27-alpine
LABEL app.wdashboard.base-path="${BASE_PATH}"
COPY --from=builder /app/client-dist /usr/share/nginx/html
COPY client/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
