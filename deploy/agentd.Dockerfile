# agentd in a container: a machine that runs Kovan's agents with nobody at it. Used for the App
# Store reviewers' demo machine (deploy/docker-compose.demo.yml); see deploy/README.md.
#   docker build -f deploy/agentd.Dockerfile -t kovan-agentd .

FROM node:22-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json turbo.json ./
COPY scripts scripts
# Fixes to dependencies (pnpm patchedDependencies): install refuses to run without them.
COPY patches patches
COPY packages packages
RUN pnpm install --frozen-lockfile --filter "@kovan/agentd..." \
 && pnpm --filter "@kovan/agentd..." build \
 && pnpm --filter @kovan/agentd deploy --prod --legacy /out

FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out/package.json ./package.json
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/dist ./dist
COPY deploy/demo /app/demo
RUN chmod +x /app/demo/entrypoint.sh \
 && mkdir -p /work /data \
 && chown node:node /work /data
# Writable places only: the checkouts (/work), agentd's state and a home for git (/data).
ENV HOME=/data/home \
    KOVAN_DATA_DIR=/data/agentd \
    KOVAN_REPOS=/work/sample-shop \
    GIT_AUTHOR_NAME="Kovan demo" GIT_AUTHOR_EMAIL=demo@kovan.alperkayan.dev \
    GIT_COMMITTER_NAME="Kovan demo" GIT_COMMITTER_EMAIL=demo@kovan.alperkayan.dev
USER node
ENTRYPOINT ["/app/demo/entrypoint.sh"]
