# syntax=docker/dockerfile:1

# Build the server (and its workspace dependency @seo-tools/shared) from source,
# then collect a production-only deployment via `pnpm deploy`.
FROM node:22-alpine AS build
WORKDIR /src
RUN npm install -g pnpm@10.33.2
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter "seo-tools-mcp-xmlstock..." build
RUN pnpm --filter "seo-tools-mcp-xmlstock" --prod --legacy deploy /out

# Minimal runtime: non-root, production deps only.
FROM node:22-alpine AS runtime
LABEL org.opencontainers.image.title="seo-tools-mcp-xmlstock" \
      org.opencontainers.image.description="MCP server for Google & Yandex SERP via XMLStock (read-only)" \
      org.opencontainers.image.source="https://github.com/antohins/seo-tools-mcp" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/dist ./dist
COPY --from=build /out/package.json ./
USER node
ENTRYPOINT ["node", "dist/index.js"]
