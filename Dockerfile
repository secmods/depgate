# DepGate: web UI, API and package registries in one image, one port.
#
#   docker build -t depgate:0.1.0 .
#
# Production deployment (images only, no build): see deploy/README.md.

# ---- Dependencies for both workspaces, from the one lockfile ----
FROM node:26-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/backend/package.json packages/backend/
COPY packages/ui/package.json packages/ui/
RUN npm ci --no-audit --no-fund

# ---- Web UI ----
FROM deps AS ui-build
COPY packages/ui packages/ui
RUN npm run build --workspace=ui -- --configuration=production

# ---- Backend ----
FROM deps AS backend-build
COPY packages/backend packages/backend
RUN npm run build --workspace=@depgate/backend

# ---- Runtime: production dependencies and compiled output only ----
FROM node:26-alpine AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    UI_DIR=/app/packages/backend/public
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/backend/package.json packages/backend/
RUN npm ci --omit=dev --workspace=@depgate/backend --no-audit --no-fund \
    && npm cache clean --force

COPY --from=backend-build /app/packages/backend/dist packages/backend/dist
# Schema migrations: plain .sql files the app applies at startup. tsc does not copy them, so this is explicit.
COPY --from=backend-build /app/packages/backend/migrations packages/backend/migrations
COPY --from=ui-build /app/packages/ui/dist/ui/browser packages/backend/public

# Artifact cache directory. A named volume mounted here takes this owner, so the node user can write it.
RUN mkdir -p /var/lib/depgate/artifacts && chown node:node /var/lib/depgate/artifacts

# Unprivileged ports: Docker maps host 80/443 onto them.
USER node
EXPOSE 8080 8443

# Exec form so SIGTERM from docker stop reaches Node and it shuts down cleanly.
CMD ["node", "packages/backend/dist/index.js"]
