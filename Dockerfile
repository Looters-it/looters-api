# Debian, not Alpine: Prisma's query engine is several times slower on musl when many
# requests run at once (measured with the load test, see docs/LOAD.md).
FROM node:22-bookworm-slim AS base
# Prisma's query engine needs OpenSSL; wget is for the container health check.
RUN apt-get update && apt-get install -y --no-install-recommends openssl wget ca-certificates util-linux \
  && rm -rf /var/lib/apt/lists/* && corepack enable
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm exec prisma generate && pnpm build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY package.json docker-entrypoint.sh ./
EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
