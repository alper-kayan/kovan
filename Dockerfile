# The Kovan server (Brain) and the website it serves.
#   docker build -t kovan-server .
# See deploy/README.md for running it.

FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json turbo.json ./
COPY scripts scripts
# Fixes to dependencies (pnpm patchedDependencies): install refuses to run without them.
COPY patches patches
# The manifests first: the install is cached until a dependency changes, not on every code
# change (each fresh install left ~0.5 GB of build cache on the host).
COPY packages/shared/package.json packages/shared/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
# Only what the server and the site need; the desktop app is not built here.
RUN pnpm install --frozen-lockfile --ignore-scripts \
      --filter @kovan/shared --filter @kovan/server --filter @kovan/web
COPY packages/shared packages/shared
COPY apps/server apps/server
COPY apps/web apps/web
RUN pnpm --filter @kovan/shared build \
 && pnpm --filter @kovan/server build \
 && pnpm --filter @kovan/web build
RUN pnpm --filter @kovan/server deploy --prod --legacy /out \
 && cp -r apps/web/dist /out/web

FROM node:22-alpine
ENV NODE_ENV=production \
    SERVER_HOST=0.0.0.0 \
    SERVER_PORT=4807 \
    WEB_DIR=/app/web \
    TRUST_PROXY=true
WORKDIR /app
COPY --from=build --chown=node:node /out/package.json ./package.json
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/dist ./dist
COPY --from=build --chown=node:node /out/drizzle ./drizzle
COPY --from=build --chown=node:node /out/web ./web
USER node
EXPOSE 4807
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4807/health || exit 1
CMD ["node", "dist/index.js"]
