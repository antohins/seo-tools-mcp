# syntax=docker/dockerfile:1

# Build the server (and its workspace dependency @seo-tools/shared) from source,
# then collect a production-only deployment via `pnpm deploy`.
FROM node:22-alpine AS build
WORKDIR /src
RUN npm install -g pnpm@10.33.2
# Copy manifests first so the dependency layer is cached across source-only edits.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY shared/package.json shared/package.json
COPY servers/xmlstock/package.json servers/xmlstock/package.json
COPY servers/wordstat/package.json servers/wordstat/package.json
COPY servers/gsc/package.json servers/gsc/package.json
COPY servers/ywm/package.json servers/ywm/package.json
COPY servers/metrika/package.json servers/metrika/package.json
# Install only this server and its workspace deps (not the whole monorepo).
RUN pnpm install --frozen-lockfile --filter "seo-tools-mcp-wordstat..."
COPY . .
RUN pnpm --filter "seo-tools-mcp-wordstat..." build
RUN pnpm --filter "seo-tools-mcp-wordstat" --prod --legacy deploy /out

# Minimal runtime: tini as PID 1 (proper signal handling), non-root, prod deps only.
FROM node:22-alpine AS runtime
LABEL org.opencontainers.image.title="seo-tools-mcp-wordstat" \
      org.opencontainers.image.description="MCP server for Yandex Wordstat keyword frequencies (read-only)" \
      org.opencontainers.image.source="https://github.com/antohins/seo-tools-mcp" \
      org.opencontainers.image.licenses="MIT"
RUN apk add --no-cache tini
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/dist ./dist
COPY --from=build /out/package.json ./
USER node
ENTRYPOINT ["/sbin/tini", "--", "node", "dist/index.js"]
