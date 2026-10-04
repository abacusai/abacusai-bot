# The hosted web app's server: the gateway, the per-user hosts and the agent,
# plus the browser build it serves. Build from the repository root:
#
#   docker build -f apps/desktop/web-host.Dockerfile -t abacusai-bot-web .
#
# Run it with ABACUSAI_BOT_WEB_DATA on a persistent volume (each user's home
# lives there) and the identity settings described in src/web-host/gateway.ts.
FROM node:22.19-bookworm AS build
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 CI=1
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter "@abacus-ai/agent..." build
RUN pnpm --filter @abacus-ai/desktop build:web

FROM node:22.19-bookworm-slim
WORKDIR /app
COPY --from=build --chown=node:node /app /app
ENV NODE_ENV=production \
    ABACUSAI_BOT_WEB_LISTEN=0.0.0.0:8080 \
    ABACUSAI_BOT_WEB_DATA=/data
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
CMD ["node", "apps/desktop/dist/web-host/gateway.js"]
