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
  quota) → atomic `reserveQuota` (429 before any upstream call) → public alias rewritten to the agent
  id for the upstream call → on the RESPONSE the agent id is rewritten BACK to the public alias, so the
  relay is NOT byte-for-byte (S9). **Fail-closed success path (S7):** a non-streaming body or SSE
  `data:` event that is not a well-formed JSON object is NEVER relayed verbatim; the SSE transform is
  incremental (no whole-stream buffering) and, on a malformed event, emits a single sanitized error +
  `data: [DONE]` then drops the rest. A bounded time-to-first-headers aborts a hung upstream → opaque
  **504**; a non-2xx upstream response or a failed body rewrite → opaque **502**; a genuine client
  disconnect (`reply.raw` close with `writableFinished === false`) propagates to abort the upstream run
  and writes no synthetic body to the gone socket.
  `/v1/models` serves ONLY Hub published aliases (`listPublishedModels`, never the upstream id).
  `createSecureProductionProxyServer` wires it in `main.ts`.
- **M7 (usage metering / quota):** ⏳ partial — atomic quota reservation is live and enforced in the
  proxy pipeline (D-015/D-017, concurrent last-unit race tested). **Per-request usage events are now
  live (S13/D-023):** `reserveQuota` writes exactly one `usage_events` row in the SAME transaction as
  the granted quota UPDATE (on grant only, never on denial), carrying NO secret/prompt/body — only the
  org/subscription/catalogue-entry/PAT-row ids, the safe request id, and the quota cost. The
  concurrent last-quota stampede test now also asserts usage-row count == granted count. Migration
  `20260920200000_usage_events`. Remaining M7 tail is the analytics/admin READ surfaces (out of scope
  for S13, YAGNI).

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
- **M4/S3 (plan domain, subscriptions, entitlements):** ✅ core implemented (pending independent
  security review) — D-015 as reworked by **D-019** / [`ADR 008`](adr/008-plan-domain-and-explicit-subscription.md).
  Admin-configurable `Plan` (`plans`) with an authoritative `plan_catalogue_entries` mapping; a
  subscription is created only when a tenant EXPLICITLY claims a plan (`grantFromPlan`), which
  SNAPSHOTS the plan's kind + catalogue-entry set (`subscription_catalogue_entries`) so later plan
  edits never rewrite an existing subscription. Provisioning now grants NO subscription — a valid
  credential alone does NOT entitle `/v1/*`; the `apps/web/app/lib/entitlement.ts` gate requires an
  active, in-quota entitlement. State machine `active → {suspended, canceled, expired}`,
  `suspended → {active, canceled, expired}` (suspended is NOT entitling). `one_time_per_organization`
  is enforced by a `plan_claims` UNIQUE ledger (`23505` → `plan_already_claimed`). Entitlement is the
  UNION of active in-window subscriptions (`resolveEntitlement`, now exposing
  `entitledCatalogueEntryIds` for later intersection with catalogue + PAT scopes). Quota reservation
  is a single atomic conditional UPDATE (`reserveQuota`, `FOR UPDATE`, no read-compare-write);
  integration proves no over-draw under a concurrent last-quota stampede and that snapshot offerings
  are frozen. NO payment provider (D-004). A seeded `free-trial` plan (quota 200, one-time) is the
  default claim target. Deferred: claim/admin UI (Stage G), data-plane agent intersection, metering
  (M7), subscription outbox. Migrations `20260919170000_subscriptions` + `20260920180000_plan_domain`.
- **M3 (catalogue):** ✅ core implemented (pending independent security review) — D-014.
  Admin-published `public_alias → upstream_agent_id` map (`catalogue_entries`, migration
  `20260919160000_catalogue`). Fail-closed resolution: only `published` aliases resolve;
  `draft`/`disabled` do not. The upstream agent id is never projected to clients — the public
  path (`toPublicModel`, repository `listPublished`, api-contracts `toModelList`) omits it by
  construction, asserted by unit + integration tests. Admin mutations gated by `requireAdmin`
  (canonical DB role) before validation, recording the acting admin. Proxy `/v1/models` +
  alias resolution wiring is Stage E (M6); admin UI is Stage G. Deferred: no catalogue outbox
  events / platform-audit table yet (traceability via created_by/updated_by/version).

- **S15 (browser/control-plane E2E) — harness implemented (D-024):** a TEST-ONLY Better Auth session
  seam lets a Playwright suite obtain a real session for a SEEDED persona without OAuth, while the
  production auth path is byte-for-byte unchanged. Config gains a fail-closed guard (`e2eTestAuth`
  truthy only when `E2E_TEST_AUTH="1"`; HARD FAILS if enabled under `NODE_ENV=production`; requires a
  ≥32-char `E2E_SESSION_SEED_KEY`). The seam plugin (`apps/web/app/lib/e2e-auth-seam.ts`) exposes
  EXACTLY `POST /e2e/sign-in`, re-checks the flag, constant-time compares `x-e2e-seed-key`, looks up an
  EXISTING user only (never creates/provisions), and mints via `createSession` + `setSessionCookie`.
  It is wired ONLY in `buildE2EAuthOptions` (which throws under production and unless the seam is
  enabled); production `buildAuthOptions` has no seam and no `E2E_TEST_AUTH` branch. Harness files
  (`playwright.config.ts`, `e2e/global-setup.ts` seeding via the REAL provisioning services +
  repositories, `e2e/fixtures.ts`, and user/admin/unauthenticated `*.spec.ts` journeys) are in place;
  Vitest excludes `e2e/**`. **Execution of the Playwright suite is a CI responsibility** (new
  `browser-e2e` job: Postgres + migrations + Chromium + `E2E_TEST_AUTH=1` ephemeral env) — it was NOT
  run in the sandbox (no browsers/Postgres/`@playwright/test`) and is NOT claimed to pass locally.
  Verified in-sandbox: config **44** + web **158** unit tests pass (`e2e/**` excluded), config/web
  typecheck + lint clean. Independent security review of the seam still pending (S15c).

- **S16-17 (live E2E runbook + Connect client messaging):** `docs/LIVE_E2E_RUNBOOK.md` documents
  the full manual live path — Compose Postgres/Redis, annotated `.env` (names only; no secrets),
  `db:migrate:deploy`, starting web/proxy/worker, live OAuth sign-in + atomic provisioning, admin
  catalogue discovery/publish, plan claim, one-time PAT mint, driving the Hub from curl / OpenAI
  SDK / Open WebUI at `${HUB_PUBLIC_URL}/v1`, and revoke — with the boundary invariants to check
  (no internal URL/agent-id/credential leak; PAT/cookies not forwarded; atomic quota; fail-closed
  `/v1/*`). The Connect page (`/connect/<alias>`) is refactored into a pure `ConnectView`
  (`apps/web/app/connect/[alias]/connect-view.tsx`) rendering copy-paste curl/OpenAI-Python/
  OpenAI-Node/Open-WebUI snippets from the PUBLIC base URL + public alias, showing the PAT only as
  the `$SCULPIN_HUB_PAT` placeholder and never an internal id/URL/credential. Verified in-sandbox:
  web **161** unit tests pass (new `ConnectView` render/no-leak tests included), web typecheck +
  lint clean. The browser journey (`e2e/user-journey.spec.ts`) asserts the Quick-start snippets and
  the no-leak surface; its execution remains the CI `browser-e2e` job's responsibility.

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

Usage analytics/admin READ surfaces (M7 tail; per-request usage events themselves ARE now recorded —
S13/D-023), Redis enforcement, Azure infra. (Authentication,
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

- `prisma:generate`: OK. `tsc --noEmit` clean across domain/config/api-contracts/db + web + proxy;
  eslint clean. Deterministic unit tests re-run 2026-09-20 and green across packages: web **161**,
  domain **116**, config **44**, api-contracts **7**, db unit **27** (56 integration skipped —
  Postgres-gated), proxy **79** (rewrite 18, data-plane 22, server 20, errors 8, cancellation 4,
  upstream 4, shutdown 3; the 12 `proxy.e2e.test.ts` cases are Postgres-gated and skipped). The
  proxy suite grew with the S7 fail-closed alias rewrite (`rewrite.test.ts`) and the real-socket S6/S10
  cancellation tests (`cancellation.test.ts`).
  Integration tests require Compose Postgres (run via `run-db-integration.mjs` with an ephemeral DB;
  stable across repeated runs, including `pat.integration.test.ts` (6),
  `subscription.integration.test.ts` (now **9** — adds usage-event assertions: a granted reservation
  writes exactly one `usage_events` row with the right ids/quota_cost, a denied reservation (no active
  sub OR exhausted) writes none, and the concurrent last-quota stampede records usage rows == granted
  count; S13/D-023), and `catalogue.integration.test.ts` (7, adds the `listPublishedModels`
  proxy-projection test)).
  `db:migration:test` drift-free. Note: the outbox suite now clears `outbox_events` in its
  `beforeAll` to own the table (fixes a pre-existing cross-suite ordering flake; see D-016).
- **Stage F end-to-end (D-018; expanded S14; rebuilt around D-019):** `pnpm test:e2e`
  (`scripts/run-proxy-e2e.mjs`, ephemeral DB) drives the real secure proxy with the **stock `openai`
  SDK** (7.20.0) against a fake in-process Sculpin — **12 cases**. Entitlement is now constructed the
  way production does (D-019, no auto-trial): `plan.create` → `attachCatalogueEntry` →
  `subscription.grantFromPlan` (which snapshots the offering set). Cases: the seeded free-trial plan
  fixture (fixed uuid, quota 200, published + self-service, one-time, zero offerings) matches the
  migration; lists only the published alias; non-stream + SSE chat pass through with the agent id
  rewritten back to the alias; **a provisioned tenant that never claims a plan is denied 403
  `no_active_subscription` on BOTH the models and chat paths (the load-bearing D-019 no-auto-trial
  proof)**; unknown model → 404; a separate active-but-drained subscription → 429 (distinct from the
  403 no-sub case); bogus PAT → 401; revoked PAT → 401 immediately; a PAT scoped away from the alias →
  404. **Every pre-dispatch denial (401/403/404/429) asserts the fake Sculpin request count is
  unchanged — no unauthorized request ever reaches the upstream.** The fake Sculpin sees the Hub bearer
  + rewritten agent id but NEITHER the caller PAT NOR cookies; conversation isolation is proven at the
  SDK edge (a caller-forged `x-exodus-conversation-id` + `x-agent-platform-include-metadata` are never
  relayed upstream, and the upstream conversation/`server` response headers are never returned); and
  the S13 metering proof — a served request writes exactly one `usage_events` row (correct
  catalogue-entry id, PAT ROW id, `quota_cost=1`, no secret) while a 404 writes none. The suite is
  `RUN_PROXY_E2E`-guarded (skipped/offline in the normal proxy unit run: 79 pass, 12 skipped) and is
  proven only in CI (needs Postgres).
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
  authz is not "any PAT calls anything". _(Superseded by D-019: entitlement now derives from an
  EXPLICIT plan claim + per-subscription snapshot, not a trial auto-granted on provisioning.)_
- **Phase D — metering + atomic quota (M7).** ✅ core implemented (S13/D-023): atomic quota
  reservation (tested at last quota under concurrency) now also writes a per-request `usage_events`
  row in the SAME transaction on grant — no secrets/prompts/bodies. Remaining tail: analytics/admin
  READ surfaces (out of scope for S13).

No open blockers: the Sculpin tenant-mapping decision that shapes Phase C is **resolved** by
D-008 (single shared upstream credential; admin-curated public-alias→agent map).

Manual test prerequisites (user): SSH tunnel putting Sculpin on the configured
`SCULPIN_UPSTREAM_URL`; Google redirect URI `http://localhost:3002/api/auth/callback/google`;
real GitHub creds if GitHub sign-in is wanted.
