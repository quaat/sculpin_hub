# Sculpin Hub — Status

Live snapshot of where the project is. Update as milestones progress. Milestone definitions and
acceptance criteria are in [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md).

_Last updated: 2026-09-17_

## Current focus

- **M0 (Sculpin discovery):** ✅ complete — [`SCULPIN_INTEGRATION.md`](SCULPIN_INTEGRATION.md)
  written from source-only investigation of the read-only upstream. Key findings:
  - OpenAI surface = `agent-api` FastAPI on **port 8001**, base URL `/v1`. Real routes:
    `GET /v1/models`, `POST /v1/chat/completions` (SSE when `stream:true`), plus Sculpin's own
    `/v1/api-keys` management routes. **No** `/v1/embeddings` or `/v1/completions`.
  - Inbound auth = `Authorization: Bearer <key>`, checked against env
    `OPENAI_COMPAT_DEV_API_KEY` (dev) then hashed `api_keys` rows (`sk-exodus-...`).
  - `model` = agent slug or UUID. SSE = `data: <json>\n\n`, `: keep-alive\n\n`, `data: [DONE]`.
  - A separate native `/api/v1/*` back-office API exists and must be denied by the proxy.
  - **Caveat:** upstream `usage` is a heuristic (`len/4`), not real tokens (D-007).
  - Proxy route policy derived → D-006. Tenant-mapping question flagged to user (DECISIONS OPEN).
- **M1 (scaffolding):** ✅ complete — CLAUDE.md, AGENT.md, and the full `docs/` scaffolding set
  created and cross-referenced.
- **M2 (identity):** ADR 004 resolved → **Better Auth**, database sessions, Google/GitHub, PKCE
  everywhere, linking off by default (Auth.js v5 DB-strategy is the fallback). See
  [`adr/004`](adr/004-auth-session-storage-open-decision.md), D-009, D-010, D-011.
  - Implemented: Better Auth config (`apps/web/app/lib/auth.ts`), catch-all route handler,
    session accessor, browser client, session-aware dashboard.
  - **Atomic sign-up provisioning wired (D-011):** a Prisma `$transaction`-capturing proxy +
    `databaseHooks.user.create.before` (captures verified profile) +
    `account.create.before` (runs `provisionPersonalTenant` then `reconcileAdminBootstrap`) —
    all inside Better Auth's `createOAuthUser` transaction. No orphan window; fails closed if no
    tx in scope. The earlier STOP in `auth.ts` is resolved.
  - **Security review done** (opus sub-agent, read-only): 0 critical. Applied fixes — account
    linking now disabled EXPLICITLY (library default is ON — see D-012), org insert is
    concurrency-safe (`ON CONFLICT DO NOTHING` + race re-read), admin-bootstrap docstring
    corrected. Deferred to the live-DB step: persist `provider_email`/`email_verified` and back
    the admin decision with the DB row (H-1); provider-double integration test + a
    no-orphan-user CI invariant (M-1).
  - Deterministic tests: 38/38 web tests pass (auth 13, admin-bootstrap 7, provisioning 8,
    app 5, health 3, next.config 2); web tsc + eslint clean.
  - **Still pending before M2 can be declared complete:** live-DB verification — migration deploy
    + real Google/GitHub OAuth sign-up exercising the atomic path and the
    `emailVerified`-in-`user.create.before` assumption; then H-1 + M-1. No DB is running yet.

## Foundation already in place (from prior branches)

- Monorepo: `apps/{web,proxy,worker}`, `packages/{config,api-contracts,db,domain,jobs,observability}`.
- Web pages `/`, `/products`, `/pricing`, `/dashboard`, `/documentation`; health endpoints on
  web and proxy. Proxy `/v1/*` registry is **empty and fail-closed** (unregistered routes are
  never forwarded) — this is the intended M6 starting point.
- Prisma tenant-persistence baseline: `User`, `ExternalIdentity`, `Organization`,
  `OrganizationMembership`, `AuditEvent`, `OutboxEvent` (transactional outbox). Prisma Migrate
  is the single migration authority.
- CI, Docker (non-root images), Compose Postgres/Redis, deterministic unit suite with no live
  external calls.

## Explicitly NOT enabled yet

Authentication, OAuth callbacks, sessions, subscriptions, PATs, usage accounting, Sculpin
forwarding, production proxy routes, Redis enforcement, admin bootstrap, Azure infra.

## Uncommitted working-tree changes

- `packages/config/src/models.ts` (new) + `export * from "./models.js"` in
  `packages/config/src/index.ts` — Foundry model constants (`claude-opus-5`, `claude-fable-5`).
- Scaffolding docs (this set) and `.claude/settings.local.json` sandbox read-allow for the
  Sculpin upstream (gitignored).

## Next up

M2 identity (Google/GitHub OAuth; resolve ADR 004). Blocked on user input for the Sculpin
tenant-mapping decision (DECISIONS "OPEN") before M3 catalogue design is finalized.
