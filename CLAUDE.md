# CLAUDE.md — Sculpin Hub

Guidance for Claude Code (and any AI agent) working in this repository. Read this first.

## What this project is

**Sculpin Hub** (workspace name `sculpin-knowledge-hub`) is an independently deployable
access, subscription, administration, and **OpenAI-API-v1 broker** layer that sits in
FRONT of **Sculpin**. Sculpin already exposes AI agents through an OpenAI-compatible API.
The Hub lets users authenticate, obtain subscriptions (no payments in v1), mint personal
access tokens (PATs), and use those PATs with standard OpenAI clients against the Hub's
`/v1/...` endpoint. The Hub authenticates, authorizes, meters, audits, and **proxies**
accepted requests to Sculpin — never a blind reverse proxy.

The upstream Sculpin repo lives at `/home/thomas/project/semanticmatter/sculpin` and is
**READ-ONLY**. Never modify, run, or write to it. See `docs/SCULPIN_INTEGRATION.md`.

## Non-negotiable security rules (fail closed)

These come from the mission and MUST hold in every change:

1. **Default DENY for `/v1/*`.** Unknown proxy routes are rejected, never forwarded. The
   production route registry (`apps/proxy/src/registry.ts`) starts empty; routes are added
   only by reviewed code, never selected from env or client input.
2. **PATs:** format `sclp_pat_<public-id>_<secret>`. Raw token is CSPRNG-generated, shown
   once, never stored/logged/recoverable. Store only an **HMAC-SHA-256 keyed digest** of the
   secret (key `PAT_HASH_SECRET`, kept OUTSIDE the DB). Verify in constant time. A DB leak
   must not yield usable tokens.
3. **Never forward the caller's PAT, cookies, or `Authorization` upstream.** Replace with
   `Authorization: Bearer ${SCULPIN_UPSTREAM_API_KEY}`. Centralize upstream-credential
   handling in one module. That credential never touches the DB, browsers, logs, usage
   events, error pages, or API responses.
4. **Never expose the internal Sculpin URL** (`SCULPIN_UPSTREAM_URL`) to clients. No
   user/admin-supplied upstream URLs (no SSRF). Strip hop-by-hop headers.
5. **Never log** secrets, bearer tokens, prompts, or model responses. No request/response
   body logging by default. Usage accounting records neither raw PATs, OAuth tokens, the
   upstream key, complete bodies, prompts, nor generated responses.
6. **Trial quota decrement must be atomic** (no read-compare-increment). Test concurrent
   last-quota attempts.
7. **No unsafe cross-provider account linking** by matching email.
8. `.env.example` has names/docs, never secrets. Validate required env at startup; fail with
   a clear message. Production secrets via Azure Key Vault + managed identity.

## Architecture at a glance

- **Monorepo:** pnpm workspaces + Turborepo. `apps/` (`web` Next.js App Router, `proxy`
  Fastify data plane, `worker`), `packages/` (`config`, `api-contracts`, `db` Prisma,
  `domain`, `jobs`, `observability`).
- **Control plane vs data plane** are separated; the proxy is isolated for API traffic.
- **DB:** PostgreSQL via Prisma (single migration authority). Transactional outbox present.
- **Roles:** USER / ADMIN, server-side authz; admin bootstrap via `BOOTSTRAP_ADMIN_EMAILS`.
- Architecture must not preclude later orgs/teams/billing/multiple Sculpins.

## Toolchain & how to run things

- Node `22.22.2` (`.nvmrc`), pnpm `10.28.1` via Corepack. **The environment's ambient pnpm/
  node may mismatch** and fail with `ERR_PNPM_UNSUPPORTED_ENGINE`. When that happens, invoke
  compilers directly instead of via pnpm scripts:
  - typecheck: `node node_modules/typescript/bin/tsc -p <pkg>/tsconfig.json --noEmit`
  - lint: `node node_modules/eslint/bin/eslint.js <path>` (NOT the `.bin/eslint` wrapper).
- Normal scripts (when engine matches): `pnpm dev | lint | typecheck | test | build`,
  `pnpm test:integration` (needs Compose Postgres), `pnpm db:migrate:deploy`,
  `pnpm prisma:generate|validate|format`, `pnpm db:migration:test`, `pnpm env:smoke`.
- Local deps: `docker compose up -d postgres redis` (Postgres `127.0.0.1:5432`, Redis
  `127.0.0.1:6379`).

## Sandbox notes for agents

- Paths under `/home/thomas` are masked by the default sandbox EXCEPT allow-listed ones.
  Reading the Sculpin upstream (`/home/thomas/project/semanticmatter/sculpin`) is enabled via
  `.claude/settings.local.json`. If a path shows char-device placeholders, that's masking —
  it does NOT mean the files are absent. Verify with `dangerouslyDisableSandbox` before
  concluding anything is missing.
- Use `model: "opus"` for sub-agents; do NOT hardcode a versioned model id.

## Where to look

The **authoritative** spec is the milestone tracker + decisions + ADRs + current status
(below). The long-form plan is **historical/superseded** background only — it references
LinkedIn/Stripe, which v1 does not use; where it conflicts, the sources below win.

- Authoritative milestones: `docs/IMPLEMENTATION_PLAN.md`. Current state: `docs/STATUS.md`.
- Decisions: `docs/DECISIONS.md` + `docs/adr/`. Threats: `docs/THREAT_MODEL.md`.
- Upstream contract: `docs/SCULPIN_INTEGRATION.md`. Orchestration: `AGENT.md`.
- Historical design (superseded): `docs/sculpin-knowledge-hub-implementation-plan.md`.

## Working style in this repo

Small, reviewable milestones (see `docs/IMPLEMENTATION_PLAN.md`). Do not implement the whole
system in one pass. Verify before declaring a milestone complete. Keep the deterministic test
suite free of live external calls (Google, GitHub, Sculpin, Azure). Prefer test doubles.
