# Sculpin Knowledge Hub

Foundation workspace for the Sculpin Knowledge Hub. It provides a public presentation UI, health-aware web/proxy/worker workloads, shared configuration/contracts/logging/database/job seams, local PostgreSQL and Redis, tests, CI, and secure container foundations. **The access, subscription, and OpenAI-compatible broker core is live (M2–M7):** Google/GitHub OAuth (PKCE, database sessions) with atomic personal-tenant provisioning and admin bootstrap; an admin catalogue of public model aliases; trial/commercial subscriptions with atomic quota; Personal Access Tokens (mint-once, HMAC keyed digest); and a fail-closed OpenAI-compatible `/v1` broker that authenticates, authorizes, meters, and proxies to Sculpin with centralized upstream-credential injection.

> **Not enabled yet:** per-request usage analytics/audit surfaces (the M7 metering tail; atomic quota reservation itself is live), a web UI for PAT and catalogue management, Redis rate enforcement, and Azure infrastructure. All price content is illustrative. See [`docs/STATUS.md`](docs/STATUS.md) for the live snapshot.

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
pnpm --filter @sculpin/web dev        # http://localhost:3002
pnpm --filter @sculpin/proxy dev      # http://127.0.0.1:3001
pnpm --filter @sculpin/worker dev     # readiness check, then intentionally idle
pnpm env:smoke                        # verify all workspaces can load root .env (values redacted)
```

Web pages: `/`, `/products`, `/pricing`, `/dashboard`, and `/documentation`. Web health is `/api/health/live` and `/api/health/ready`; proxy health is `/health/live` and `/health/ready`. Readiness is `503` when PostgreSQL cannot answer. The proxy registers exactly `GET /v1/models` and `POST /v1/chat/completions`; every other `/v1/*` route returns a normalized unsupported-operation response and is never forwarded.

## Use the Hub with an OpenAI client

The proxy is an OpenAI-compatible broker. Point any standard OpenAI client at the Hub's `/v1` base URL and authenticate with a Personal Access Token (`sclp_pat_<id>_<secret>`) as `Authorization: Bearer <token>`:

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.SCULPIN_HUB_PAT,
  baseURL: "https://your-hub.example.com/v1",
});
const completion = await client.chat.completions.create({
  model: "support", // a published Hub alias, never an internal agent id
  messages: [{ role: "user", content: "Hello" }],
});
```

The Hub authenticates the PAT, checks an active subscription and atomically reserves quota, resolves the public alias to the upstream agent, injects its own upstream credential (the caller's token/cookies are never forwarded), and streams the response back incrementally when `stream: true` — preserving SSE framing and ordering while rewriting the internal agent id in the `model` field back to the public alias (so it is not byte-for-byte) and failing closed on a malformed event. Deployment configures `SCULPIN_UPSTREAM_URL`, `SCULPIN_UPSTREAM_API_KEY`, and `PAT_HASH_SECRET` (see `.env.example`); the internal Sculpin URL and upstream key are never exposed to clients. See [`/documentation`](apps/web/app/documentation/page.tsx) for the full contract.

## Validate

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration                 # requires the Compose PostgreSQL service
pnpm test:e2e                         # proxy E2E: stock OpenAI SDK + fake Sculpin + ephemeral DB
pnpm build
```

Run formatting fixes with `pnpm format`. The deterministic unit suite does not call Google, GitHub, Sculpin, Azure, or any other external service (identity uses Google/GitHub; there is no payment provider in v1 — see [D-004](docs/DECISIONS.md#d-004--mission-supersedes-the-long-form-plan-on-identity--billing)).

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

The script verifies non-root image users, web/proxy liveness and PostgreSQL readiness from final production images, Prisma Client load/initialization through readiness, the worker's deliberate idle state, and bounded `SIGTERM` shutdown. Proxy and worker shutdown is single-shot, closes owned pools at most once, reports failures safely, and forces a non-zero exit on failure or timeout. PostgreSQL readiness uses `SELECT 1` with a two-second query timeout; idle pool errors are passed to a safe workload logging callback without connection details.

Public readiness returns only `ready`/`not_ready` and the service name. Dependency names remain internal to reduce infrastructure disclosure. Redis is not a readiness dependency because no workload uses it yet.

The production data plane registers exactly `GET /v1/models` and `POST /v1/chat/completions` through a reviewed route builder; the base route registry itself stays empty (default DENY), so `/v1`, `/v1/`, and every other nested `/v1/*` operation return a normalized error and are never forwarded. All upstream-credential handling is isolated to a single module that injects the Hub credential and strips caller credentials and hop-by-hop headers.

## Architecture and next work

- [Implementation plan](docs/sculpin-knowledge-hub-implementation-plan.md)
- [UI design specification](docs/ui-design-spec.md)
- [Architecture decisions](docs/adr/)

Identity (M2), the model catalogue (M3), subscriptions/entitlements with atomic quota (M4), Personal Access Tokens (M5), and the fail-closed OpenAI-compatible broker (M6) are implemented and covered by unit, integration, and an end-to-end suite that drives the stock OpenAI SDK against a fake Sculpin (`pnpm test:e2e`). The remaining focused increments are the M7 metering/analytics tail, a web UI for PAT and catalogue management, and Azure deployment (M8). See [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) and [`docs/STATUS.md`](docs/STATUS.md).

## Tenant persistence baseline

Prisma is generated and validated from `packages/db/prisma/schema.prisma`:

```bash
pnpm prisma:format --check
pnpm prisma:validate
pnpm prisma:generate
```

Prisma Migrate is the single migration authority. Apply reviewed SQL migrations to a local PostgreSQL database with:

```bash
DATABASE_URL=postgresql://sculpin:password@127.0.0.1:5432/sculpin_hub pnpm db:migrate:deploy
```

Migration tests require PostgreSQL access through `DATABASE_URL`; they create a fresh temporary database, deploy migrations twice, check Prisma migration status, validate and generate the Prisma Client, run the Prisma-supported drift check with a shadow database, and directly exercise custom PostgreSQL triggers, checks, foreign keys, and index-backed invariants that Prisma diff does not inspect:

```bash
DATABASE_URL=postgresql://sculpin:password@127.0.0.1:5432/sculpin_hub pnpm db:migration:test
```

The tenant persistence baseline implements users, external identities, personal organizations, memberships, append-only audit events, and the transactional outbox. Layered on top and live: identity (Google/GitHub OAuth, database sessions, admin bootstrap — M2), the model catalogue (M3), subscriptions/entitlements with atomic quota (M4), Personal Access Tokens (M5), and the fail-closed OpenAI-compatible `/v1` broker (M6). Still disabled: per-request usage analytics/audit surfaces (M7 tail), Redis enforcement, and Azure infrastructure.

### ESLint framework rules

The repository currently uses flat ESLint with strict TypeScript rules across the monorepo. The Next.js recommended plugin is not enabled in this branch because no user-facing Next.js behavior changes here; adding the plugin is intentionally deferred to a web-focused branch so framework-specific rule changes can be reviewed separately from persistence semantics.
