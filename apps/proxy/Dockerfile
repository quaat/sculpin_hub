FROM node:22.22.2-alpine AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.28.1 --activate
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @sculpin/proxy... build && pnpm --filter @sculpin/proxy deploy --prod /out
FROM node:22.22.2-alpine AS runtime
ENV NODE_ENV=production PROXY_HOST=0.0.0.0
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY --from=build --chown=app:app /out ./
USER app
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD wget -qO- http://127.0.0.1:3001/health/live || exit 1
CMD ["node", "dist/main.js"]
