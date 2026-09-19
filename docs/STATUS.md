# Sculpin Hub — Status

Live snapshot of where the project is. Update as milestones progress. Milestone definitions and
acceptance criteria are in [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md).

_Last updated: 2026-09-19_

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
  - Proxy route policy derived → D-006. Sculpin tenant-mapping **resolved** by D-008
    (single shared upstream credential; admin-curated public-alias→agent map; per-tenant keys
    deferred). No open blocker remains here.
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
  - **✅ Live-DB verified (2026-09-19):** Postgres/Redis up via Compose; migrations deployed;
    web/proxy/worker running (web :3002, proxy :3001). Real Google OAuth sign-in works
    end-to-end — `POST /api/auth/sign-in/social` returns a Google redirect with PKCE (S256) +
    state; the atomic personal-tenant provisioning path is exercised on first sign-in.
    Fixes made during bring-up: async `getAuth()` awaiting `database.ready()`; singular Prisma
    delegate model names; `advanced.database.generateId` emits UUIDs to match `@db.Uuid` id
    columns. Still open follow-ups: H-1 (persist `provider_email`/`email_verified`) and M-1
    (provider-double integration test + no-orphan-user CI invariant).
  - **⚠️ Schema tradeoff (CLAUDE.md rule 5):** per an explicit product decision, the Full Better
    Auth schema migration (`20260919120000_better_auth_full_schema`) added provider
    `access_token`/`refresh_token`/`id_token`/expiries/`scope`/`password` columns to
    `external_identities`, relaxing minimal-token-retention. Revisit: encrypt-at-rest or prune.

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

Subscriptions/entitlements, PATs, usage accounting, production proxy routes (fail-closed
registry still empty), Redis enforcement, Azure infra. (Authentication, OAuth callbacks,
sessions, and admin bootstrap are now live per M2.)

**⚠️ Dev-only blind forwarder present:** `apps/proxy/src/forward.ts` + `server.ts` route
`/v1/*` straight to `SCULPIN_UPSTREAM_URL`, forwarding the caller's headers verbatim and NOT
injecting the upstream credential. It is **gated to `NODE_ENV=development`** in
`parseProxyConfig` (undefined upstream ⇒ `/v1/*` stays fail-closed 404), so it cannot activate
in production. It is a temporary bring-up hack for local Sculpin smoke-testing and **still
violates CLAUDE.md rules 1/3/4 in dev** (forwards caller PAT/cookies; no credential injection;
blind route pass-through). It MUST be replaced by the fail-closed registry + centralized
credential injection (Phase A of [`NEXT_PHASE_PLAN.md`](NEXT_PHASE_PLAN.md)) before any real
test-case use.

## Working-tree state

- Tracked tree is **clean** — the prior `packages/config/src/models.ts` (Foundry model
  constants) and scaffolding docs are committed. Only untracked non-project artifacts remain
  (local `.env`/dotfiles, `pr3.patch`, `sculpin_hub*.zip`); none are committed.
- `.claude/settings.local.json` (sandbox read-allow for the read-only Sculpin upstream) is
  local-only and untracked.

## Baseline verification (2026-09-19)

- `pnpm install --frozen-lockfile` and `prisma:generate`: OK. `tsc --noEmit` clean for web +
  proxy. Unit tests: **111 passed / 15 skipped**; web package **38/38** under its own config.
  Integration tests require Compose Postgres (skipped in the deterministic run).
- **Env caveat:** the sandbox pins Node to v26 while the repo targets `22.22.2`. `turbo` fails
  with "cannot find package manager binary" until the nvm `v22.22.2/bin` dir is on `PATH`
  (which supplies a real `pnpm` shim); with that prefix the standard `pnpm lint|typecheck|test`
  scripts run. Alternatively invoke compilers directly per CLAUDE.md.
- **Test-runner caveat:** running the root `vitest` across all packages misreports
  `apps/web/app/app.test.tsx` as failing ("React is not defined") because the web JSX-automatic
  runtime lives in `apps/web/vitest.config.ts`; run web tests package-scoped (they pass 38/38).

## Next up — path to a real test-case scenario

Goal: a signed-in user mints a PAT and uses it with a stock OpenAI client against the Hub's
`/v1`, which authenticates, authorizes, meters, and proxies to Sculpin. Thin vertical slice
across M3/M5/M6/M7:

- **Phase A — safe real proxy (M6 core).** Delete the blind forwarder. Register EXACTLY
  `GET /v1/models` + `POST /v1/chat/completions` (SSE passthrough) in the fail-closed registry
  via reviewed code. Centralize upstream-credential injection in one module: strip caller
  `Authorization`/cookies/hop-by-hop, set `Authorization: Bearer ${SCULPIN_UPSTREAM_API_KEY}`,
  never leak the internal `SCULPIN_UPSTREAM_URL`. Fixed upstream base (no client-influenced target).
- **Phase B — PAT auth (M5).** Mint `sclp_pat_<id>_<secret>` (CSPRNG, shown once), store only
  HMAC-SHA-256 keyed digest (`PAT_HASH_SECRET` outside DB), constant-time verify. Gate `/v1/*`
  on a valid PAT resolving to an active user/org.
- **Phase C — catalogue + minimal entitlement (M3 + thin M4).** Admin-published model alias →
  upstream agent id map (public alias only; internal ids never leaked). Minimal entitlement so
  authz is not "any PAT calls anything": grant a trial subscription on provisioning.
- **Phase D — metering + atomic quota (M7).** Usage events with no secrets/prompts/bodies;
  atomic trial-quota reservation (tested at last quota under concurrency).

No open blockers: the Sculpin tenant-mapping decision that shapes Phase C is **resolved** by
D-008 (single shared upstream credential; admin-curated public-alias→agent map).

Manual test prerequisites (user): SSH tunnel putting Sculpin on the configured
`SCULPIN_UPSTREAM_URL`; Google redirect URI `http://localhost:3002/api/auth/callback/google`;
real GitHub creds if GitHub sign-in is wanted.
