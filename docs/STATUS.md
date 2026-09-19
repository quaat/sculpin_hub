# Sculpin Hub — Status

Live snapshot of where the project is. Update as milestones progress. Milestone definitions and
acceptance criteria are in [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md).

_Last updated: 2026-09-20_

## Current focus

- **M6 (OpenAI-compatible proxy / broker):** ✅ core implemented, **independent security review
  PASS** — D-017. The production data plane registers EXACTLY `GET /v1/models` +
  `POST /v1/chat/completions` via the reviewed `createDataPlaneRouteRegistry`
  (`apps/proxy/src/data-plane.ts`); the fail-closed `registry.ts` stays empty (CLAUDE.md rule 1).
  Upstream-credential handling is isolated to `apps/proxy/src/upstream.ts` (the only reader of
  `SCULPIN_UPSTREAM_URL`/`_API_KEY`): it strips caller `Authorization`/cookies/hop-by-hop, forwards a
  tiny request-header allowlist, injects `Authorization: Bearer ${SCULPIN_UPSTREAM_API_KEY}`, and
  projects responses onto a caller-safe allowlist (rules 3-4). Pipeline fails closed in order:
  PAT auth (opaque 401) → body validate (400) → entitlement (403) → PUBLISHED alias→agent (404 before
  quota) → atomic `reserveQuota` (429 before any upstream call) → alias rewritten to the agent id →
  byte-for-byte JSON/SSE passthrough with client-disconnect abort → opaque 502 on upstream failure.
  `/v1/models` serves ONLY Hub published aliases (`listPublishedModels`, never the upstream id).
  `createSecureProductionProxyServer` wires it in `main.ts`.
- **M7 (usage metering / quota):** ⏳ partial — atomic quota reservation is live and enforced in the
  proxy pipeline (D-015/D-017, concurrent last-unit race tested); per-request usage events +
  analytics/audit surfaces are the remaining M7 tail.

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
    corrected.
  - **H-1 RESOLVED (2026-09-19):** `provider_email`/`email_verified` are mapped via Better Auth
    `account.additionalFields` and persisted from the verified profile in `account.create.before`,
    so the admin-bootstrap decision is backed by the durable `external_identities` row (D-013).
  - **M-1 RESOLVED (2026-09-19):** `packages/db/src/identity.integration.test.ts` (ephemeral
    Postgres, real migrations) asserts the pruned token columns are absent, the Hub-owned columns
    remain, and the no-orphan-user invariant holds (and detects a planted orphan). A full
    HTTP-level provider-double sign-up E2E is deferred to Stage F.
  - **Server-side authz primitives (2026-09-19):** `apps/web/app/lib/session.ts` adds
    `requireUser` / `requireAdmin` / `requireOrganization`, which re-derive authorization from the
    canonical DB row every call (User active; platform role from `users.role`, not the session;
    active membership in an active org) — a valid session alone is insufficient (D-013).
  - Deterministic tests: 51/51 web tests pass (auth 13, session/authz 13, admin-bootstrap 7,
    provisioning 8, app 5, health 3, next.config 2); web tsc + eslint clean.
  - **✅ Live-DB verified (2026-09-19):** Postgres/Redis up via Compose; migrations deployed;
    web/proxy/worker running (web :3002, proxy :3001). Real Google OAuth sign-in works
    end-to-end — `POST /api/auth/sign-in/social` returns a Google redirect with PKCE (S256) +
    state; the atomic personal-tenant provisioning path is exercised on first sign-in.
    Fixes made during bring-up: async `getAuth()` awaiting `database.ready()`; singular Prisma
    delegate model names; `advanced.database.generateId` emits UUIDs to match `@db.Uuid` id
    columns.
  - **✅ OAuth token retention RESOLVED → PRUNE (ADR 006 / D-013, 2026-09-19):** the token
    columns that `20260919120000` had added are DROPPED by
    `20260919140000_prune_oauth_tokens`. The Hub only authenticates a person (never calls a
    provider API for them), so it keeps only `provider`/`provider_subject`/`provider_email`/
    `email_verified`/`safe_metadata`. Defense-in-depth: columns absent + `create.before` strips
    the fields + `updateAccountOnSignIn:false`; cost is `validateSchema:false` (drift caught by
    Prisma Migrate + integration tests). A DB leak yields no usable provider credentials.
  - **Independent security review of the hardening slice (2026-09-19):** read-only opus
    reviewer, verdict **PASS** — 0 blocking, 2 LOW. LOW-1 (stored `provider_email`/`email_verified`
    are `input:true`) is not exploitable today (admin bootstrap reads the in-transaction verified
    profile, never the column) and is now pinned by an invariant comment in `auth.ts`. LOW-2
    (`validateSchema:false`) is a bounded, documented trade-off (ADR 006). Confirmed: token
    non-retention (columns dropped + `create.before` strips all 7 fields + no logging), authz
    primitives re-derive from canonical rows (role from `users.role`, malformed uuids rejected
    pre-store, parameterized SQL), `accountLinking:false`, and the outbox trigger only strengthens.
  - **Foundation repairs (2026-09-19):** hardened the personal-org outbox trigger to classify a
    degenerate `{}` payload as "payload invalid" (`20260919150000`); added the missing
    `migration_lock.toml`; declared `onUpdate: NoAction` on all relations to match deployed SQL —
    `db:migration:test` (`migrate diff --exit-code`) is now drift-free. See D-013.
- **M5 (personal access tokens):** ✅ core implemented (pending independent security review) —
  D-016 / ADR 007. Wire format `sclp_pat_<public-id>_<secret>` (22+43 base62, CSPRNG rejection
  sampling); only an HMAC-SHA-256 keyed digest of the secret is stored (`personal_access_tokens`,
  migration `20260920120000_personal_access_tokens`; key `PAT_HASH_SECRET` OUTSIDE the DB). The raw
  token is shown once and never stored/logged/recoverable; `authenticate` re-derives an active
  user/org/membership, verifies in constant time, and returns a single opaque failure (dummy HMAC on
  miss). Control-plane mint/list/revoke gated by `requireUser`, scoped to the caller's personal org
  (`apps/web/app/lib/pat.ts`). Integration proves the DB holds no usable bearer credential and that
  revocation/expiry/inactive-owner fail closed. Deferred: `/v1/*` PAT auth in the proxy (M6),
  per-token usage (M7), admin PAT UI (Stage G), key rotation (future ADR).
- **M4 (subscriptions/entitlements):** ✅ core implemented (pending independent security review) —
  D-015. Subscription state machine (`active` → `canceled`/`expired`), entitlement as the UNION of
  active in-window subscriptions (`resolveEntitlement`), and a `trial` (quota 200) granted in the
  SAME provisioning transaction so a valid credential alone does NOT entitle `/v1/*` — the
  `apps/web/app/lib/entitlement.ts` gate additionally requires an active, in-quota entitlement.
  Quota reservation is a single atomic conditional UPDATE (`reserveQuota`, `FOR UPDATE`, no
  read-compare-write); an integration test proves no over-draw under a concurrent last-quota
  stampede. NO payment provider (D-004). Deferred: metering/analytics (M7), subscription outbox,
  admin subscription UI (Stage G). Migration `20260919170000_subscriptions`.
- **M3 (catalogue):** ✅ core implemented (pending independent security review) — D-014.
  Admin-published `public_alias → upstream_agent_id` map (`catalogue_entries`, migration
  `20260919160000_catalogue`). Fail-closed resolution: only `published` aliases resolve;
  `draft`/`disabled` do not. The upstream agent id is never projected to clients — the public
  path (`toPublicModel`, repository `listPublished`, api-contracts `toModelList`) omits it by
  construction, asserted by unit + integration tests. Admin mutations gated by `requireAdmin`
  (canonical DB role) before validation, recording the acting admin. Proxy `/v1/models` +
  alias resolution wiring is Stage E (M6); admin UI is Stage G. Deferred: no catalogue outbox
  events / platform-audit table yet (traceability via created_by/updated_by/version).

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

Per-request usage accounting/analytics (M7 tail), Redis enforcement, Azure infra. (Authentication,
OAuth callbacks, sessions, and admin bootstrap are live per M2; catalogue/subscriptions/PATs per
M3/M4/M5; the production `/v1/models` + `/v1/chat/completions` broker with PAT auth, entitlement +
atomic quota gating, and centralized upstream-credential injection is live per M6/D-017. The
`registry.ts` default-DENY list itself remains empty — routes are added only via the reviewed
`createDataPlaneRouteRegistry`.)

**✅ Dev-only blind forwarder DELETED (Stage A):** the temporary `apps/proxy/src/forward.ts`
bring-up hack (which forwarded caller headers verbatim to `SCULPIN_UPSTREAM_URL` without
credential injection) has been removed; `/v1/*` is once again fully fail-closed via the empty
registry. The production data plane will be built as the reviewed fail-closed registry +
centralized credential injection in M6/M7 — NOT as an unauthenticated intermediate proxy.

## Working-tree state

- Tracked tree is **clean** — the prior `packages/config/src/models.ts` (Foundry model
  constants) and scaffolding docs are committed. Only untracked non-project artifacts remain
  (local `.env`/dotfiles, `pr3.patch`, `sculpin_hub*.zip`); none are committed.
- `.claude/settings.local.json` (sandbox read-allow for the read-only Sculpin upstream) is
  local-only and untracked.

## Baseline verification (2026-09-20)

- `prisma:generate`: OK. `tsc --noEmit` clean across domain/config/api-contracts/db + web + proxy.
  Unit tests green across packages; web package **77/77** under its own config (auth 13,
  session/authz 13, catalogue 10, entitlement 7, pat 9, admin-bootstrap 7, provisioning 8, app 5,
  health 3, next.config 2); domain **63/63** (adds PAT format/name); db **20/20** (index 9, pat 11);
  api-contracts **7/7** (adds the M6 data-plane error builders + chat schema); proxy **47/47**
  (data-plane 12, server 20, errors 8, upstream 4, shutdown 3).
  Integration tests require Compose Postgres (run via `run-db-integration.mjs` with an ephemeral DB;
  **38/38**, stable across repeated runs, including `pat.integration.test.ts` (6),
  `subscription.integration.test.ts` (6, incl. the concurrent last-unit quota race), and
  `catalogue.integration.test.ts` (7, adds the `listPublishedModels` proxy-projection test)).
  `db:migration:test` drift-free. Note: the outbox suite now clears `outbox_events` in its
  `beforeAll` to own the table (fixes a pre-existing cross-suite ordering flake; see D-016).
- **Stage F end-to-end (D-018):** `pnpm test:e2e` (`scripts/run-proxy-e2e.mjs`, ephemeral DB) drives
  the real secure proxy with the **stock `openai` SDK** (7.20.0) against a fake in-process Sculpin —
  **6/6** green: lists only the published alias, non-stream + SSE chat pass through, unknown model →
  404 and drained quota → 429 (neither calls upstream), bogus PAT → 401, and the fake Sculpin sees the
  Hub bearer + rewritten agent id but NEITHER the caller PAT NOR cookies. The suite is
  `RUN_PROXY_E2E`-guarded (skipped/offline in the normal proxy unit run: 47 pass, 6 skipped).
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
