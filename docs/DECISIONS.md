# Sculpin Hub — Decision Log

Running log of orchestration-level decisions made while building the Hub. Architecture-grade
decisions get a formal record in [`adr/`](adr/); this file captures the lighter-weight and
in-flight decisions, with pointers to ADRs where relevant.

## D-001 — Reuse the `sculpin_hub` foundation

**Decision:** Build on the existing `sculpin_hub` (underscore) workspace rather than the empty
`sculpin-hub` (hyphen) directory. The foundation already matches the mission (monorepo, health
seams, fail-closed empty proxy registry, Prisma tenant baseline).
**Date:** 2026-09-17. **By:** user choice.

## D-002 — Fix the environment via sandbox read-allow for the upstream

**Decision:** Grant sandbox `filesystem.allowRead` + a `Read(...)` permission for
`/home/thomas/project/semanticmatter/sculpin` in `sculpin_hub/.claude/settings.local.json`
(gitignored), and relaunch Claude Code from the `sculpin_hub` directory. Rationale: a prior
investigation sub-agent produced a false negative ("Sculpin does not exist") because the
default sandbox masked `/home/thomas`. The upstream remains **read-only** — no write access.
**Date:** 2026-09-17. **By:** user choice.

## D-003 — Sub-agents use `model: "opus"`

**Decision:** Spawn all sub-agents with `model: "opus"` (the alias), never a versioned model id
that would become obsolete. **Date:** 2026-09-17. **By:** mission instruction.

## D-004 — Mission supersedes the long-form plan on identity & billing

**Decision:** The current mission overrides the older long-form plan where they conflict:

- Identity providers are **Google and GitHub** (the long-form plan and `plan.md` say Google/
  **LinkedIn**).
- **No payment provider in v1** — trial and commercial subscriptions exist, but there is no
  Stripe/checkout/billing integration (the long-form plan includes Stripe). Architecture must
  still not preclude adding billing later.
  **Date:** 2026-09-17. **By:** mission instruction. Supersedes conflicting parts of
  [`sculpin-knowledge-hub-implementation-plan.md`](sculpin-knowledge-hub-implementation-plan.md).
  Note: ADR 004 (auth session storage) is still Open and must be resolved in M2.

## D-005 — PAT verification uses HMAC, not password hashing

**Decision:** For high-entropy machine-generated PATs, store an **HMAC-SHA-256 keyed digest**
of the secret (key `PAT_HASH_SECRET` held outside the DB), verified in constant time — not a
slow password hash. Rationale: tokens already carry ≥256 bits of entropy, so a keyed digest
gives efficient indexed lookup + verification while a DB leak stays non-usable.
**Date:** 2026-09-17. **By:** mission instruction. Formal ADR to be written in M5.

## D-006 — Proxy route policy from M0 findings (input to M6)

**Decision:** Based on [`SCULPIN_INTEGRATION.md`](SCULPIN_INTEGRATION.md), the Hub's fail-closed
`/v1/*` registry will register **only** `GET /v1/models` and `POST /v1/chat/completions`. It
will **DENY** Sculpin's own `/v1/api-keys` management routes (the Hub manages its own upstream
credential and must not expose Sculpin key management to callers) and the entire native
`/api/v1/*` back-office API. Requests for `/v1/embeddings` or `/v1/completions` return an
OpenAI-shaped `unsupported`/404 — there is no upstream to proxy them to.
**Date:** 2026-09-17. **By:** derived from M0. To be ratified when M6 is designed.

## D-007 — Do NOT trust Sculpin's reported token usage for metering

**Decision:** Sculpin's `/v1/chat/completions` `usage` object is a heuristic (`len/4`), not real
token counts, and `finish_reason` is always `stop`. Hub quota/metering (M7) MUST NOT rely on
upstream-reported usage for billing-grade accounting. Meter by request count and/or the Hub's
own measured input/output sizes, and treat any upstream usage as advisory only.
**Date:** 2026-09-17. **By:** derived from M0. Affects M4 entitlements and M7 metering design.

## D-011 — Atomic sign-up provisioning via adapter-wrap (resolves D-010 item 2)

**Decision:** Preserve the "every user has a personal org/tenant context" invariant by running
`provisionPersonalTenant(tx, …)` (personal org + owner membership + audit + outbox) inside the
**same interactive transaction** that Better Auth's OAuth new-user path (`createOAuthUser`) opens
for the `user` + `account` inserts. Where/join/sort translation stays delegated to the stock
adapter. **No orphan window.** Chosen over 2-phase+reconciliation (introduces an un-provisioned
window) and a full custom adapter (~200 LOC coupled to internals).

**Concrete mechanism (verified against `better-auth@1.7.5` source, `apps/web/app/lib/auth.ts`):**

- The Prisma client handed to `prismaAdapter` is wrapped by `withProvisioningTxCapture`, a Proxy
  whose interactive `$transaction(fn)` runs `fn` inside an `AsyncLocalStorage` carrying the tx
  client. (Array/batch `$transaction` and all other members pass through untouched.)
- Provisioning is triggered from **`databaseHooks.account.create.before`**, NOT user create.
  Rationale from source: in `createOAuthUser` the user row is created first, then the account —
  both inside one `runWithTransaction`. `create.before` hooks run _in-transaction_, but
  `create.after` hooks are queued via `queueAfterTransactionHook` and fire **post-commit
  (non-atomic)**. `user.create.before` has no user id yet. `account.create.before` is the only
  config-level seam that runs in-transaction _after_ the user row exists (it carries
  `account.userId`), so that is where provisioning runs.
- `provisionPersonalTenant` no longer inserts the user (Better Auth owns `users` and, via the
  account create, `external_identities`). It is idempotent (skips if a personal org already
  exists for the user) and **fails closed** if no tx client is in scope — refusing to create the
  account rather than risk an orphan user.

**Accepted coupling:** depends on `createOAuthUser` wrapping user+account in one transaction and
on `create.before` running in-transaction — pin `better-auth` (1.7.5) and re-verify on upgrade.
**Date:** 2026-09-17. **By:** user choice. Implemented in M2.

## D-013 — M2 identity hardening: token prune, authz primitives, outbox/migration repairs

**Decision (2026-09-19):** Complete the M2 identity slice with four changes:

1. **OAuth provider tokens are pruned, not retained → see [ADR 006](adr/006-oauth-token-non-retention.md).**
   The `20260919120000` migration had (per an earlier product decision) ADDED
   `access_token`/`refresh_token`/`id_token`/`*_expires_at`/`scope`/`password` to
   `external_identities`, contradicting the code comments and CLAUDE.md rule 5. Since the Hub only
   authenticates a person (it never calls a provider API on their behalf), migration
   `20260919140000_prune_oauth_tokens` DROPS those columns. Defense-in-depth: the columns are
   absent (schema authority), `account.create.before` strips the fields to `undefined`, and
   `account.updateAccountOnSignIn = false` disables the refresh-on-sign-in write. Cost:
   `advanced.database.validateSchema = false` (Better Auth's adapter schema check requires a
   column for every writable field); drift is instead caught by Prisma Migrate + integration
   tests. A DB leak now yields no usable provider credentials.

2. **Server-side authz primitives (`requireUser` / `requireAdmin` / `requireOrganization`)** in
   `apps/web/app/lib/session.ts`. A valid Better Auth session is treated as an untrusted hint;
   each primitive re-derives authorization from the CANONICAL DB row on every call (fail closed):
   `users.status = active`; `users.role = admin` for admin (the session role claim is never
   trusted); an ACTIVE membership in an ACTIVE organization for org scope. This defends against a
   stale cookie outliving deactivation, demotion, membership revocation, or org suspension.
   Unit-tested with injected doubles in `session.test.ts` (no live DB).

3. **Outbox trigger hardening (`20260919150000_harden_outbox_payload_check`).** The
   personal-organization outbox trigger classified a degenerate `{}` payload as "owner missing"
   because `array_agg(key) <> ARRAY[...]` is NULL for an empty object (so the payload-invalid
   branch was skipped). Coalescing the key array + explicit `userId` guard now correctly rejects
   it as "payload invalid". Security outcome unchanged (still rejected); classification fixed.

4. **Migration tooling repairs.** Added the missing `migration_lock.toml` (Prisma could not
   determine the connector for `migrate diff`), and declared `onUpdate: NoAction` on every
   relation in `schema.prisma` to match the deployed SQL (inline `REFERENCES` default to
   `NO ACTION`, while Prisma's datamodel implicitly assumes `onUpdate: Cascade`). This removed a
   whole-schema false "drift" so `db:migration:test` (`migrate diff --exit-code`) is now clean.
   No behavioural DDL change — it reconciles the declared model with the already-deployed database.

**Verification:** all-package typecheck, lint, unit tests (web 51), DB integration (19 incl. the
new identity suite), `prisma validate`, and the full `run-db-migration-test.mjs` (idempotent
deploy, status, validate, generate, drift-free diff, SQL invariants) pass. An independent
security review of this slice is required before sign-off (implementer never self-approves).
**By:** M2 completion pass.

## D-014 — M3 model catalogue: alias→agent map, fail-closed, upstream never leaked

**Decision (2026-09-19):** Implement the M3 catalogue as a platform-global admin resource mapping
a client-visible `public_alias` (the OpenAI `model` id) to an internal Sculpin `upstream_agent_id`.

1. **Data model** (`catalogue_entries`, migration `20260919160000_catalogue`): `public_alias`
   (unique, client-facing), `upstream_agent_id` (internal, never projected), `display_name`,
   `description?`, `status` (`draft`/`published`/`disabled`), `created_by`/`updated_by` (acting
   admin, for traceability), `version`. Column CHECKs mirror the domain validation (defense in
   depth). FKs use `ON DELETE RESTRICT` to match the schema-wide convention (drift-free).

2. **Fail-closed resolution.** `resolvePublishedAlias(alias)` returns the upstream agent id ONLY
   when `status = 'published'`; `draft` and `disabled` never resolve. `publish` → `published`,
   `unpublish` → `disabled`.

3. **Upstream never leaked (CLAUDE.md rules 3-4).** The client projection is a single function
   `toPublicModel` / the repository's `listPublished`, both of which structurally omit
   `upstream_agent_id` (the public SQL query does not even select the column). The api-contracts
   `toModelList` input type carries only `{ id, created }`, so the OpenAI `/v1/models` body cannot
   serialize an agent id. Unit + integration tests assert the agent id never appears in any public
   output.

4. **Admin gating.** `apps/web/app/lib/catalogue.ts` gates every mutation with `requireAdmin`
   (canonical DB role, per [[D-013]]) BEFORE input validation, and records the acting admin id.
   Reads of the public model list are intentionally un-gated (aliases only).

**Scope (deferred, not in M3):** no outbox events for catalogue changes (the outbox validator +
trigger remain scoped to `personal_organization.created`); no platform-level audit table (the
org-scoped `audit_events` requires an org id and does not fit a global resource) — traceability is
via `created_by`/`updated_by`/`version`. Proxy consumption of `/v1/models` + alias resolution is
Stage E (M6). Admin UI is Stage G.

**Verification:** all-package typecheck + lint clean; unit (domain 25, api-contracts 5, db 9, web
61); DB integration 25 incl. the new `catalogue.integration.test.ts` (6); `db:migration:test`
drift-free. An independent security review of this slice is required before sign-off.
**By:** M3 implementation pass.

## D-015 — M4 subscriptions & entitlements: trial-on-provisioning, union entitlement, atomic quota

**Decision (2026-09-19):** Implement M4 as a subscription state machine + entitlement resolution
with NO payment provider ([[D-004]]).

1. **Data model** (`subscriptions`, migration `20260919170000_subscriptions`): `organization_id`
   (FK `ON DELETE RESTRICT`), `plan` (`trial`/`commercial`), `status` (`active`/`canceled`/
   `expired`), `quota_limit`, `quota_used`, `starts_at`, `ends_at?`, `version`. A DB CHECK
   `quota_used <= quota_limit` is defense-in-depth against over-draw (CLAUDE.md rule 6).

2. **State machine.** `active` is the only non-terminal state; `active → canceled` and
   `active → expired` are the sole transitions (terminal states are dead — reactivation mints a new
   subscription). Enforced in the domain (`assertSubscriptionTransition`) AND in SQL
   (`setStatus` updates only `WHERE status = 'active'`, atomically stamping `ends_at`).

3. **Entitlement = union of active subscriptions.** `resolveEntitlement` (pure, unit-tested)
   treats a subscription as active when `status = 'active'` AND in its validity window
   (`ends_at` future or NULL); `remainingQuota` is the pooled unused budget across those.

4. **Trial on provisioning (fail-closed authz).** _Superseded in part by [[D-019]]:_ auto-granting
   a trial at provisioning is removed in favour of an EXPLICIT plan-claim journey (a provisioned
   tenant now has NO subscription until it claims a plan). The rest of this item still holds — a
   valid session/PAT alone does NOT entitle `/v1/*`; `requireEntitledOrganization`
   (`apps/web/app/lib/entitlement.ts`) requires an active, in-quota entitlement, throwing stable
   `AuthzError` reasons (`no_active_subscription`/`quota_exhausted`). Originally: every personal
   tenant was granted an `active` `trial` (`TRIAL_REQUEST_QUOTA = 200`) inside the SAME provisioning
   transaction (web Prisma `provisionPersonalTenant` + pg `PostgresPersonalTenantTransaction`).

5. **Atomic quota reservation (CLAUDE.md rule 6).** `reserveQuota` is a single conditional UPDATE
   whose target row is selected + row-locked (`FOR UPDATE`, no `SKIP LOCKED`) by a subquery
   matching an active, in-window subscription with `quota_used + amount <= quota_limit`. No
   read-compare-write anywhere. An integration test fires 25 concurrent last-quota reservations
   against a budget of 5 and asserts exactly 5 succeed and `quota_used` never exceeds
   `quota_limit`.

**Scope (deferred, not in M4):** no usage/metering events, analytics, or audit surfaces (M7); no
subscription outbox events; `commercial` subscriptions are provisioned administratively (no
payment provider, [[D-004]]); admin subscription UI is Stage G. Per-request metering that consumes
`reserveQuota` lands with the proxy data plane (M6/M7). Do NOT rely on Sculpin's upstream `usage`
for accounting ([[D-007]]).

**Verification:** all-package typecheck + lint clean; unit (domain 46, web 68 incl. new
`entitlement.test.ts` 7); DB integration 31 incl. the new `subscription.integration.test.ts` (6);
`db:migration:test` drift-free. An independent security review of this slice is required before
sign-off. **By:** M4 implementation pass.

## D-016 — M5 Personal Access Tokens: mint-once, HMAC keyed digest at rest, constant-time verify

**Decision (2026-09-20):** Implement M5 per CLAUDE.md rule 2 and [`ADR 007`](adr/007-personal-access-tokens.md).

1. **Wire format** `sclp_pat_<public-id>_<secret>`: 22-char base62 public id (~131 bits, an
   unauthenticated lookup handle, stored cleartext + uniquely indexed) and 43-char base62 secret
   (~256 bits, the bearer proof). Both from `crypto.randomBytes` with rejection sampling (unbiased
   base62). Pure domain helpers `parsePatToken`/`formatPatToken`/`validatePatName`; a malformed
   token parses to `undefined` (no oracle).

2. **At rest** (`personal_access_tokens`, migration `20260920120000_personal_access_tokens`):
   store ONLY `secret_hash = base64(HMAC-SHA-256(secret, PAT_HASH_SECRET))`; the raw secret is
   never persisted/logged/recoverable. The key `PAT_HASH_SECRET` lives in validated config
   (`z.string().min(32).max(512)`), OUTSIDE the DB. Columns: `public_id` (unique), `user_id`/
   `organization_id` (FK `ON DELETE RESTRICT`), `name`, `secret_hash`, `status`
   (`active`/`revoked`), `last_used_at?`, `expires_at?`, `revoked_at?`, `version`.

3. **Verify (constant time).** `verifyPatSecretHash` uses `timingSafeEqual`. `authenticate`
   looks up on `public_id` via a JOIN that re-derives an ACTIVE user + org + membership and an
   active, unexpired PAT (fail closed), computes an HMAC on EVERY path (dummy digest on miss) so
   miss and wrong-secret are timing-indistinguishable, returns a single opaque `undefined` on any
   failure, and touches `last_used_at` only on success.

4. **Lifecycle & scope.** Mint/list/revoke gated by `requireUser`
   (`apps/web/app/lib/pat.ts`); PATs are scoped to the caller's PERSONAL org (team PATs deferred).
   The raw token is returned exactly once at mint. `revoke` is owner-scoped and idempotent.

5. **Test isolation fix (not a weakening).** `outbox.integration.test.ts` asserts on GLOBAL claim
   ordering; because provisioning suites share the ephemeral DB and (under vitest's non-alphabetical
   file ordering) can run first, they left unclaimed `personal_organization.created` events with an
   earlier `available_at`. Added a `DELETE FROM outbox_events` in the outbox suite's `beforeAll` so
   it owns the table — this restores the pre-existing latent flake to determinism (subscription
   already provisioned at M4; M5 merely made the ordering surface reliably).

**Scope (deferred, not in M5):** the data-plane `/v1/*` authentication that consumes
`authenticate` lands with the proxy (M6); no PAT-scoped rate limits or per-token usage (M7); no PAT
admin UI (Stage G); `PAT_HASH_SECRET` rotation (dual-key verify window) is a future ADR.

**Verification:** all-package typecheck + lint clean; unit (domain 63 incl. PAT format/name, web 77
incl. new `pat.test.ts` 9, db 20 incl. new `pat.test.ts` 11 with a no-token-logging assertion); DB
integration 37 incl. the new
`pat.integration.test.ts` (6); `db:migration:test` drift-free; integration stable across repeated
runs. An independent security review of this slice is required before sign-off. **By:** M5
implementation pass.

## D-017 — M6/M7 secure data plane: reviewed fail-closed registry, centralized credential boundary

**Decision (2026-09-20):** Build the production `/v1/*` data plane as a reviewed route registry that
registers EXACTLY the two OpenAI-compatible operations the Hub supports, with all upstream-credential
handling isolated to a single module. This resolves Phase A/B/D of the "next up" slice ([[D-006]],
[[D-008]], [[D-014]], [[D-015]], [[D-016]]).

1. **Default DENY preserved (CLAUDE.md rule 1).** `apps/proxy/src/registry.ts` stays empty; routes
   are added ONLY by the reviewed `createDataPlaneRouteRegistry` in `apps/proxy/src/data-plane.ts`,
   which registers `GET /v1/models` + `POST /v1/chat/completions` and nothing else. Routes are never
   selected from env or client input; every other `/v1/*` path stays fail-closed → 404.

2. **Centralized credential boundary (CLAUDE.md rules 3-4).** _Header-allowlist details superseded by
   [[D-022]] (conversation isolation): the request allowlist is now EMPTY and the response allowlist is
   reduced to `content-type`._ `apps/proxy/src/upstream.ts` is the
   ONLY code that reads `SCULPIN_UPSTREAM_URL`/`SCULPIN_UPSTREAM_API_KEY`. It strips the caller's
   `Authorization`/`cookie`/`proxy-authorization` and all hop-by-hop headers, forwards only a reviewed
   request-header allowlist (now EMPTY per [[D-022]]), and
   injects `Authorization: Bearer ${SCULPIN_UPSTREAM_API_KEY}`. Responses are projected onto a
   caller-safe header allowlist (drops `set-cookie`, `server`, internal headers). The internal URL/key
   never touch logs, response bodies, or error pages.

3. **Fail-closed pipeline order.** _"byte-for-byte passthrough" superseded: S9 replaced it with an
   alias rewrite, and [[D-022]] adds metadata stripping plus a bounded first-headers timeout → 504._
   authenticate PAT (single
   opaque 401, [[D-016]]) → validate body
   (400) → entitlement active (403, [[D-015]]) → resolve PUBLISHED alias→agent (404 BEFORE quota, so
   an unknown model never burns budget, [[D-014]]) → atomic `reserveQuota` (429 BEFORE any upstream
   call, [[D-015]] rule 6) → rewrite `model` to the upstream agent id → call upstream → byte-for-byte
   passthrough (JSON or SSE) via `Readable.fromWeb`, propagating client disconnect to an
   `AbortController`. Any upstream throw → opaque 502 with no internal detail.

4. **`/v1/models` serves the Hub catalogue, not the upstream.** `listPublishedModels` selects only
   `public_alias` + `created_at` (never `upstream_agent_id`) and feeds `toModelList`, so the OpenAI
   models body cannot serialize an internal agent id.

**Scope (deferred, not in M6):** per-token/per-request usage events + analytics surfaces (the M7
metering tail) are not yet wired; the upstream base is a fixed deployment value (no private-range
SSRF guard by design — no client-influenced target); best-effort accounting does not refund a unit on
a subsequent upstream failure (v1 usage is not billed).

**Verification:** proxy typecheck + lint clean; proxy unit 47 (new `data-plane.test.ts` 12 +
`upstream.test.ts` 4) incl. an end-to-end test that wires the REAL upstream module through a fetch spy
and proves the caller PAT/cookie never reach the outbound request; api-contracts 7; db unit 20; DB
integration 38 (adds a catalogue `listPublishedModels` projection test); the concurrent last-unit
quota race is covered by `subscription.integration.test.ts`. **Independent opus security review:
PASS** (0 blocking, 0 major, 5 minor/by-design). **By:** M6/M7 implementation pass.

## D-018 — Stage F: deterministic end-to-end proof with the stock OpenAI SDK

**Decision (2026-09-20):** Add a deterministic, self-contained end-to-end test that drives the real
secure proxy with the **stock `openai` npm SDK** (pinned `7.20.0`, a workspace-root devDependency)
against a **fake in-process Sculpin** and an **ephemeral PostgreSQL** — exercising the whole
M3/M4/M5/M6 slice at once with NO live external calls ([[D-017]], CLAUDE.md "keep the deterministic
suite free of live external calls").

1. **Harness.** `apps/proxy/src/proxy.e2e.test.ts` (guarded by `RUN_PROXY_E2E=true`; `describe.skip`
   otherwise, so the normal proxy unit run stays offline). It seeds via the real control-plane
   services — `PostgresPersonalTenantTransaction.create` (grants the active trial),
   `PostgresCatalogueRepository.create`+`publish`, and `PostgresPatService.mint` (a real one-time
   PAT) — starts a `node:http` fake Sculpin that records every inbound request and replies with an
   OpenAI-shaped JSON body or SSE stream, and boots `createSecureProductionProxyServer` on an
   ephemeral port. `scripts/run-proxy-e2e.mjs` (root script `test:e2e`) provisions/migrates/drops the
   ephemeral DB, mirroring `run-db-integration.mjs` but invoking the Prisma binary directly (no pnpm
   dependency in the runner).

2. **What it proves.** A stock OpenAI client with a real PAT: lists ONLY the published alias (never
   the agent id); completes a non-streaming chat (upstream body passed through); streams SSE through
   the SDK's parser; gets 404 for an unknown model and 429 when quota is drained — both WITHOUT any
   upstream call; and is denied 401 for a bogus PAT. It re-asserts the credential boundary at the
   network edge: the fake Sculpin sees `Authorization: Bearer <SCULPIN_UPSTREAM_API_KEY>`, the
   rewritten agent id, and NEITHER the caller's PAT NOR the injected `cookie`/`x-random-header`.

3. **Dependency note.** `openai` is a dev-only dependency used solely by this test; it never enters
   any app runtime bundle. Pinned exact (repo convention); lockfile updated.

**Scope (deferred):** an HTTP-level provider-double OAuth sign-up E2E (M2 tail) and Azure/ops
readiness remain M9. This harness is the cross-milestone functional down-payment on M9's "E2E flows".

**Verification:** `test:e2e` → **6/6** green (stock OpenAI SDK, ephemeral PG, fake Sculpin); the suite
is skipped and offline under the normal proxy unit run (47 pass, 6 skipped); proxy typecheck + lint
clean. **By:** Stage F implementation pass.

## D-019 — S3 plan domain + explicit subscription claim (supersedes trial-on-provisioning)

**Decision (2026-09-20):** Replace the thin M4 subscription slice with an admin-configurable plan
domain and an EXPLICIT subscription-claim journey. Full rationale, snapshot semantics, and the
enum-swap migration are recorded in [`ADR 008`](adr/008-plan-domain-and-explicit-subscription.md);
this supersedes the trial-on-provisioning slice of [[D-015]] (its union-entitlement + atomic-quota
mechanics still hold).

1. **`Plan` model** (`plans`, migration `20260920180000_plan_domain`): admin-owned product with
   `key` (unique slug), `name`, `description?`, `kind` (`free_trial`/`commercial_monthly`/
   `commercial_annual`), `enabled`, `published`, `self_service_eligible`, `admin_grantable`,
   `duration_days?`, `request_quota`, `one_time_per_organization`, `created_by`/`updated_by`,
   `version`. Column CHECKs mirror the pure `validatePlanInput` guard.

2. **Authoritative mapping.** `plan_catalogue_entries` (M2M, `catalogue_entry_id` `ON DELETE
   RESTRICT`) is the admin-configured set of Sculpin agents a plan grants.

3. **Snapshot at grant.** `SubscriptionRepository.grantFromPlan` materializes a subscription in one
   transaction and SNAPSHOTS the plan's `kind` (`subscriptions.plan_kind`) and its current
   catalogue-entry set (`subscription_catalogue_entries`, copied from `plan_catalogue_entries`).
   Later plan edits NEVER change an existing subscription's frozen offerings.

4. **Explicit claim (no auto-trial).** Provisioning grants NO subscription; both atomic paths
   (`PostgresPersonalTenantTransaction`, `provisionPersonalTenant`) still commit
   user+identity+org+membership+audit+outbox in one COMMIT ([[D-011]]) with the
   `personal_organization.created` outbox trigger intact, but write no `subscriptions` row. A seeded
   `free-trial` plan (fixed uuid, quota 200, one-time, published + self-service) is the default claim
   target; its offerings are attached by admins later.

5. **One-time invariant.** `plan_claims (organization_id, plan_id)` PK; for a
   `one_time_per_organization` plan a claim row is inserted in the SAME transaction as the
   subscription, so a second claim raises `23505` → `DomainConflictError("plan_already_claimed")`.
   Non-one-time plans write no claim row and may be subscribed repeatedly.

6. **Suspended state.** `subscription_status` gains `suspended`; the state machine is
   `active → {suspended, canceled, expired}`, `suspended → {active, canceled, expired}`, terminals
   dead. `suspended` is NOT entitling (`isSubscriptionActive` stays `active`-only). Enforced in the
   domain transition table and in SQL `setStatus`.

7. **Entitlement seam.** `resolveEntitlement` now returns
   `{ active, planKeys, remainingQuota, entitledCatalogueEntryIds }`, the last being the sorted union
   of active subscriptions' snapshot offerings — the composable seam a later milestone intersects with
   the published catalogue + PAT scopes. Atomic `reserveQuota` is unchanged from [[D-015]].

**Scope (deferred):** the claim/admin UI (Stage G); the data-plane intersection of
`entitledCatalogueEntryIds` with catalogue + PAT scopes; subscription outbox events; no payment
provider ([[D-004]]).

**Verification:** all-package typecheck + lint clean; domain unit 86, web entitlement 7, proxy 12;
`prisma validate` + format clean; `db:migration:test` drift-free with new plan/`plan_claims`/
`suspended` invariant assertions; DB integration 46 incl. the new `plan.integration.test.ts` (6) and
reworked `subscription.integration.test.ts` (8). An independent security review of this slice is
required before sign-off. **By:** S3 implementation pass.

## D-020 — S5 catalogue admin + server-side Sculpin discovery (fail-closed, no unsafe pairing)

**Decision (2026-09-20):** Add a SERVER-SIDE discovery slice that enumerates upstream Sculpin agents
via Sculpin's OpenAI `GET /v1/models`, plus catalogue-admin operations that create entries from
discovered agents and detect drift — all admin-gated and upholding [[D-014]]'s "upstream never
leaked / a public alias must never silently resolve to a replacement agent" invariant.

1. **No unsafe slug↔uuid pairing (the riskiest call).** Per `docs/SCULPIN_INTEGRATION.md` §1/§4 each
   agent is emitted TWICE (slug row + UUID row) as FLAT `{id}` strings with NO field linking the two
   rows. We therefore CANNOT reconstruct the pairing from the response, and deliberately DO NOT guess
   one (a wrong guess would silently map an alias onto a replacement agent). `parseDiscoveredAgents`
   (pure, in `@sculpin/domain`) surfaces EACH id as its own `DiscoveredAgent`, classified `isUuid`,
   and fails closed (`DomainValidationError`) on any non-`{object:"list", data:[{id}]}` payload.
   `stableDiscoveredAgentIds` returns ONLY the uuid-form ids — the STABLE-ALIAS rule: the catalogue
   `upstreamAgentId` must be the stable UUID.

2. **Least-privilege discovery credential.** New `parseDiscoveryConfig` (`@sculpin/config`) reads
   `SCULPIN_UPSTREAM_URL` (reused `httpUrl` validator; deployment-only, no SSRF) and a NEW
   `SCULPIN_DISCOVERY_API_KEY` — a SEPARATE key from the data-plane `SCULPIN_UPSTREAM_API_KEY`. S7
   ([[D-021]]) completed the broader web/data-plane secret split; this established the discovery seam so
   the web control plane need not hold the proxy's request-serving key. Fails closed with
   field-name-only errors; documented in `.env.example` (names/docs only).

3. **Centralized credential boundary (CLAUDE.md rules 3-5).** `apps/web/app/lib/discovery.ts` is the
   ONLY place that reads the discovery URL/key and calls Sculpin. Mirroring `apps/proxy/src/upstream.ts`
   it injects `Authorization: Bearer <SCULPIN_DISCOVERY_API_KEY>`, forwards NO caller credential,
   accepts an injected `fetch` (tests never call live), bounds the call with a timeout, and NEVER
   returns/logs the URL, key, or upstream body — failures surface as a sanitized `DiscoveryError`.
   Server-only (transitively imports `next/headers` via `requireAdmin`). Every call is admin-gated
   (canonical `users.role`, [[D-013]]).

4. **Fail-closed catalogue admin.** `createCatalogueEntryFromDiscovered` validates the chosen
   `upstreamAgentId` is a currently-discoverable STABLE id BEFORE creating, else
   `UndiscoverableAgentError` (never mints an alias onto a non-existent/replacement agent).
   `detectCatalogueDrift` REPORTS published entries whose agent vanished upstream (candidates to
   disable) but does NOT auto-disable (S6 UI acts). `upstreamAgentId` stays admin-only; the public
   `toPublicModel`/`listPublished` projection is unchanged. `resolvePublishedAlias` still returns ONLY
   the stored id of a PUBLISHED entry — a disappeared agent yields an upstream 404 the proxy (S8/S9)
   surfaces as fail-closed.

**Scope (deferred):** admin discovery/catalogue PAGES + HTTP handlers (S6); the broader config secret
split (S7); proxy-time alias resolution + 404 handling (S8/S9). No live Sculpin call in tests (fake
injected `fetch` per the testing rule).

**Verification:** domain + config + web typecheck/lint clean; new domain (`parseDiscoveredAgents`),
config (`parseDiscoveryConfig`), web `discovery.test.ts`, and web `catalogue.test.ts`
create-from-discovered/drift suites pass; existing catalogue tests stay green. No new DB integration
suite (all additions are pure/service-layer with injected doubles). An independent security review of
this slice is required before sign-off. **By:** S5 implementation pass.

## D-021 — S7 web/data-plane secret split (least-privilege PAT config)

**Context.** The web control plane mints/verifies/revokes PATs and so needs the PAT HMAC keyring, but
it was obtaining that keyring via `parseDataPlaneConfig`, which ALSO requires `SCULPIN_UPSTREAM_URL`
and `SCULPIN_UPSTREAM_API_KEY`. That forced the web app to hold the proxy's request-serving upstream
Sculpin credential — a least-privilege / blast-radius violation ([[D-017]], CLAUDE.md rules 3-5): a
compromised control plane could read the upstream key.

**Decision.** Add a dedicated `parsePatConfig` (`@sculpin/config`) that parses ONLY the PAT-hash env
(`PAT_HASH_SECRET`, `PAT_HASH_KEY_VERSION`, `PAT_HASH_SECRET_RETIRED`) and returns `PatConfig`
(`{ patHashSecret, patHashKeyring }`). `parseDataPlaneConfig` now composes that same `patHashSchema`
+ keyring builder (`DataPlaneConfig extends PatConfig`), so there is one keyring-construction source of
truth and no behavioral drift. `apps/web/app/lib/pat.ts` reads `parsePatConfig` — the web control
plane no longer requires (or reads) the upstream URL/key. The proxy remains the ONLY reader of
`SCULPIN_UPSTREAM_URL`/`SCULPIN_UPSTREAM_API_KEY`; admin discovery keeps its separate
`SCULPIN_DISCOVERY_API_KEY` ([[D-020]]). `.env.example` documents which component reads which secret.

**Verification.** config + web + proxy typecheck/lint clean; new `parsePatConfig` config tests
(keyring build, retired-key merge, version-collision fail-closed, short-secret rejection, no upstream
URL/key required, secret-safe errors) pass; full web suite (145) and config suite (34) green;
`parseDataPlaneConfig` behavior unchanged (its existing tests still pass). Independent security review
required before sign-off. **By:** S7 implementation pass.

## D-022 — S10-12: conversation isolation, bounded upstream timeout, metadata-leak stripping

**Context.** Three data-plane security gaps remained after S9. The upstream module still forwarded the
caller's `x-exodus-conversation-id` / `x-agent-platform-include-metadata` upstream and returned the
three `x-exodus-conversation-*` headers to clients, letting a caller supply a raw upstream conversation
id and letting upstream conversation state cross the boundary. Sculpin can also attach a non-standard
top-level `exodus` metadata object to response bodies. And a hung upstream could hold a Hub connection
open indefinitely. This tightens `.claude/rules/proxy-security.md` items (conversation isolation, SSE
streaming, logging/limits) that [[D-017]] items 2-3 no longer fully describe.

1. **Conversation isolation (S11).** `FORWARDABLE_REQUEST_HEADERS` in `apps/proxy/src/upstream.ts` is
   now an EMPTY set — NONE of the caller's headers cross to Sculpin; `content-type` and the Hub
   `Authorization` are set explicitly at the credential boundary. `FORWARDABLE_RESPONSE_HEADERS` is
   reduced to ONLY `content-type`, so the upstream `x-exodus-conversation-*` headers are never returned
   to clients. Callers can no longer supply an arbitrary raw upstream conversation id. The allowlist
   mechanism is retained (empty set) so the filtering logic stays enforced.

2. **Bounded time-to-first-headers timeout (S10).** New validated config `SCULPIN_UPSTREAM_TIMEOUT_MS`
   (`upstreamTimeoutMs`, default 30000, min 1000, max 120000). `handleChatCompletions` arms a timer
   that aborts the shared `AbortController` if the upstream does not return RESPONSE HEADERS in time,
   returning an opaque OpenAI-shaped 504 (`upstream_timeout`). The timer is DISARMED the moment headers
   arrive, so legitimately long SSE streams are never cut off. Client disconnect still aborts via the
   same controller; any other upstream throw remains an opaque 502.

3. **Metadata-leak stripping (S12).** The rewrite helpers (`rewriteModelInJsonBody` and the SSE
   `rewriteEvent`) now defensively delete an own top-level `exodus` property when the parsed payload is
   a plain object, in addition to rewriting `model` to the public alias. Non-object / unparseable
   payloads and the `[DONE]` / keepalive frames pass through verbatim; the transform never throws.

**Verification.** api-contracts (`upstreamTimeoutError` → `upstream_timeout`), config (default +
provided `SCULPIN_UPSTREAM_TIMEOUT_MS`), and proxy suites green; proxy typecheck + lint clean. New
proxy tests: request/response conversation headers dropped; non-streaming + SSE `exodus` stripped; a
slow upstream returns 504 with no internal detail. `.env.example` and `THREAT_MODEL.md` updated.
Independent security review required before sign-off. **By:** S10-12 implementation pass.

## D-012 — Disable Better Auth account linking EXPLICITLY (security review of M2)

**Decision:** Set `account.accountLinking.enabled = false` in `apps/web/app/lib/auth.ts`. An
independent security review of the M2 identity slice found that `better-auth@1.7.5` defaults
`accountLinking.enabled` to **true** with implicit on-sign-in linking (`disableImplicitLinking`
default false) — so the earlier posture of "linking off by omission" was WRONG and effectively
left automatic cross-provider email-based linking ENABLED, violating CLAUDE.md rule 7 and the
GHSA-x445-f3h2-j279 mitigation intent. Because `users.normalized_email` is non-unique, the
accepted v1 consequence of disabling is that the same human signing in with a second provider
gets a **separate, isolated account** (never a silent link/takeover). A deliberate,
session-authenticated linking flow can be added later. **Date:** 2026-09-17. **By:** security
review finding (HIGH), auto-applied. Unit-tested in `auth.test.ts`.

**Also from that review (follow-ups):**

- **H-1 (RESOLVED 2026-09-19):** `provider_email` / `email_verified` are now mapped via Better
  Auth `account.additionalFields` and populated in `account.create.before` from the verified ALS
  profile, so the admin-bootstrap decision is backed by the persisted `external_identities` row
  (auditability + defense-in-depth). Unit-tested in `auth.test.ts`; the columns are asserted
  present by `identity.integration.test.ts`.
- **M-1 (RESOLVED 2026-09-19):** `identity.integration.test.ts` runs against an ephemeral
  Postgres (real migrations) and asserts (a) the pruned OAuth token columns are absent, (b) the
  Hub-owned identity/audit columns remain, and (c) the no-orphan-user invariant — after atomic
  provisioning no `users` row lacks a personal org, and a planted orphan IS detected (proving the
  invariant query works). The deterministic hook behaviour is covered by provider-double unit
  tests in `auth.test.ts`. A full HTTP-level provider-double sign-up E2E is deferred to Stage F.
- **H-2 / L-3 (applied):** org insert is now `ON CONFLICT (personal_owner_user_id) DO NOTHING`
  with a race re-read (no self-inflicted abort on concurrent sign-up); `admin-bootstrap.ts`
  docstring corrected to state it MUST run inside the sign-up transaction.

## D-010 — Better Auth ↔ bespoke schema integration approach (M2 crux)

**Context:** The foundation provisions tenants via an **atomic** raw-`pg` transaction
(`packages/db/src/tenant.ts` `PostgresPersonalTenantTransaction`) that inserts
`users + external_identities + organizations + organization_memberships + audit_events +
outbox_events` in one COMMIT. Better Auth instead wants to own `user/session/account/
verification` via its adapter. The schema also has **no platform-level role** — `MembershipRole`
is org-scoped (owner/member), which is NOT the platform USER/ADMIN the mission requires.

**Decision (recommended for M2 implementation, verify against Better Auth docs during the PR):**

1. Let Better Auth own **`session`** and **`verification`** tables (new). Map its **`user`** to the
   existing `users` table and its **`account`** to `external_identities` via Better Auth field
   mapping — do NOT add `email`/`emailVerified`/`image` columns to `users`; keep
   `normalizedEmail`/`displayName` canonical.
2. Preserve the atomic personal-org/outbox provisioning: on first sign-in, run the existing
   `PostgresPersonalTenantTransaction` (or an equivalent single-transaction path) so a new user
   gets User + ExternalIdentity + personal Organization + membership + audit + outbox atomically.
   If Better Auth's adapter cannot cleanly participate in / defer to that single transaction, the
   implementer must STOP and report rather than splitting provisioning into a non-atomic
   after-hook that could leave a user without a personal org.
3. Add a **platform role** to `users`: enum `{ user, admin }`, default `user`; grant `admin`
   only when the **verified** provider email is in `BOOTSTRAP_ADMIN_EMAILS`, recorded in
   `AuditEvent`. This is distinct from `MembershipRole`.
   **Date:** 2026-09-17. **By:** orchestrator, from codebase inspection. Refines ADR 004 follow-ups.

## D-009 — Identity library & session strategy → see ADR 004

**Decision (pending user confirmation):** Adopt **Better Auth** with the **database (server-side)
session** strategy for the control plane; Google (OIDC) + GitHub (OAuth2); PKCE on every
provider; account linking off by default. Auth.js/NextAuth v5 (DB strategy) is the sanctioned
fallback. This reverses the plan's original Auth.js assumption. Rationale, citations, schema
reconciliation, and OAuth-safety config are in
[`adr/004-auth-session-storage-open-decision.md`](adr/004-auth-session-storage-open-decision.md)
(now **Accepted**). **Date:** 2026-09-17. **By:** derived from verified research; surfaced to
user because it's a foundational, hard-to-reverse dependency choice.

## D-008 — Sculpin tenant mapping: single shared upstream key in v1

**Decision:** The Hub authenticates to Sculpin as a **single shared upstream tenant/credential**.
All Hub users see the same agent set, surfaced through an admin-curated **public-model-alias →
Sculpin agent (slug/UUID)** map. Per-Hub-tenant Sculpin keys are deferred; the catalogue (M3) and
credential-injection (M6) modules must be structured so a per-tenant credential resolver can be
added later without rework. **Date:** 2026-09-17. **By:** user choice. Resolves the M0 open
question; shapes M3 catalogue and M4 entitlements.
