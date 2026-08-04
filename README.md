# Sculpin Knowledge Hub

Foundation workspace for the Sculpin Knowledge Hub. This slice provides a public presentation UI, health-aware web/proxy/worker workloads, shared configuration/contracts/logging/database/job seams, local PostgreSQL and Redis, tests, CI, and secure container foundations.

> **Not enabled:** authentication, organizations, subscriptions, billing, API tokens, external accounting, Sculpin forwarding, production routes, and Azure infrastructure. All catalog and price content is explicitly illustrative.

## Prerequisites

- Node.js `22.22.2` (`nvm use` reads `.nvmrc`)
- pnpm `10.28.1` via Corepack
- Docker with Compose v2 for local dependencies

## Install from a clean checkout

```bash
corepack enable
corepack prepare pnpm@10.28.1 --activate
pnpm install --frozen-lockfile
cp .env.example .env
```

`.env.example` contains non-production local values only. Do not commit `.env` files or real credentials.

Every development script uses Node.js 22's explicit `--env-file=../../.env` support from its workspace directory. This makes the root file consistent for `pnpm dev` and filtered commands without adding production dotenv loading. Next.js uses the standard `PORT` variable; proxy and worker settings remain workload-prefixed. Containers do not load `.env` and receive configuration only from their process environment.

The root command builds shared packages before starting Turborepo's persistent development tasks. Each filtered application has a `predev` build of only its workspace dependencies, so it also works independently after the locked install.

## Local dependencies

```bash
docker compose up -d postgres redis
docker compose ps
```

PostgreSQL is exposed only on `127.0.0.1:5432`; Redis is on `127.0.0.1:6379`. Both use persistent named volumes and health checks.

Stop dependencies with `docker compose down`. Reset all local data with `docker compose down --volumes` (destructive).

## Run applications

```bash
pnpm dev                              # all applications
pnpm --filter @sculpin/web dev        # http://localhost:3000
pnpm --filter @sculpin/proxy dev      # http://127.0.0.1:3001
pnpm --filter @sculpin/worker dev     # readiness check, then intentionally idle
pnpm env:smoke                        # verify all workspaces can load root .env (values redacted)
```

Web pages: `/`, `/products`, `/pricing`, `/dashboard`, and `/documentation`. Web health is `/api/health/live` and `/api/health/ready`; proxy health is `/health/live` and `/health/ready`. Readiness is `503` when PostgreSQL cannot answer. Every unregistered proxy `/v1/*` route returns a normalized unsupported-operation response and is never forwarded.

## Validate

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration                 # requires the Compose PostgreSQL service
pnpm build
```

Run formatting fixes with `pnpm format`. The deterministic unit suite does not call Google, LinkedIn, Stripe, accounting, Sculpin, Azure, or any other external service.

## Containers

Build from the repository root:

```bash
docker build -f apps/web/Dockerfile -t sculpin-hub-web .
docker build -f apps/proxy/Dockerfile -t sculpin-hub-proxy .
docker build -f apps/worker/Dockerfile -t sculpin-hub-worker .
```

Images run as non-root users. Supply runtime configuration through the deployment environment or secret manager; never bake `.env` or credentials into an image.

After building all three images and starting Compose dependencies, exercise the same container checks used by CI:

```bash
./scripts/container-smoke.sh
```

The script verifies non-root image users, web/proxy liveness and PostgreSQL readiness, the worker's deliberate idle state, and bounded `SIGTERM` shutdown. Proxy and worker shutdown is single-shot, closes owned pools at most once, reports failures safely, and forces a non-zero exit on failure or timeout. PostgreSQL readiness uses `SELECT 1` with a two-second query timeout; idle pool errors are passed to a safe workload logging callback without connection details.

Public readiness returns only `ready`/`not_ready` and the service name. Dependency names remain internal to reduce infrastructure disclosure. Redis is not a readiness dependency because no workload uses it yet.

The production Sculpin route registry remains empty. `/v1`, `/v1/`, and every unregistered nested `/v1/*` operation return a normalized error and are never forwarded.

## Architecture and next work

- [Implementation plan](docs/sculpin-knowledge-hub-implementation-plan.md)
- [UI design specification](docs/ui-design-spec.md)
- [Architecture decisions](docs/adr/)

The recommended next focused pull request is the first meaningful PostgreSQL domain baseline: users, external identities, personal organizations, memberships, audit events, and transactional outbox—without enabling OAuth until ADR 004 is resolved.

## Pull-request consolidation

PR #2 is the canonical foundation pull request. PR #1 should be closed as superseded after PR #2 passes current-head validation and merges; see [the consolidation note](docs/foundation-consolidation.md).
