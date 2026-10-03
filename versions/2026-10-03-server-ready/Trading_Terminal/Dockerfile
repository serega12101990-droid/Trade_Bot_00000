FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN npm install --global pnpm@10.11.0
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build:server

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 NORTHSTAR_DB_PATH=/data/terminal.sqlite NORTHSTAR_RUNTIME_DIR=/data/runtime
WORKDIR /app
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /data/runtime /backups && chown -R node:node /data /backups
USER node
EXPOSE 3000
CMD ["node", "scripts/server.mjs"]
