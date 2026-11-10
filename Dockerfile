# syntax=docker/dockerfile:1
# SALURA production image: builds the ops console and runs the API (which also serves the console).

ARG NODE_VERSION=22

# ---------------------------------------------------------------------------
# Build: install the workspace and build the web console
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable
WORKDIR /app

# Manifests first so dependency installs are cached across source changes
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/agent/package.json packages/agent/
COPY packages/db/package.json packages/db/
COPY packages/eval/package.json packages/eval/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# ---------------------------------------------------------------------------
# Runtime: TypeScript runs through tsx, so the workspace sources and node_modules ship as built
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
# DATABASE_URL (Postgres) comes from the environment; without it the embedded database lives in /app/data.
ENV NODE_ENV=production \
    PORT=8787
WORKDIR /app
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
VOLUME ["/app/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["./node_modules/.bin/tsx", "apps/api/src/server.ts"]
