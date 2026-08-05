FROM node:22.22.2-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.28.1 --activate
WORKDIR /app
FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/api-contracts/package.json packages/api-contracts/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/jobs/package.json packages/jobs/package.json
COPY packages/observability/package.json packages/observability/package.json
COPY packages/db/prisma/schema.prisma packages/db/prisma/schema.prisma
RUN pnpm install --frozen-lockfile
COPY apps/web apps/web
COPY packages/api-contracts packages/api-contracts
COPY packages/config packages/config
COPY packages/db packages/db
COPY packages/domain packages/domain
COPY packages/jobs packages/jobs
COPY packages/observability packages/observability
RUN pnpm prisma:generate && pnpm --filter @sculpin/web... build
FROM node:22.22.2-alpine AS runtime
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY --from=build --chown=app:app /app/apps/web/.next/standalone ./
COPY --from=build --chown=app:app /app/apps/web/.next/static ./apps/web/.next/static
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD wget -qO- http://127.0.0.1:3000/api/health/live || exit 1
CMD ["node", "apps/web/server.js"]
