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
  both inside one `runWithTransaction`. `create.before` hooks run *in-transaction*, but
  `create.after` hooks are queued via `queueAfterTransactionHook` and fire **post-commit
  (non-atomic)**. `user.create.before` has no user id yet. `account.create.before` is the only
  config-level seam that runs in-transaction *after* the user row exists (it carries
  `account.userId`), so that is where provisioning runs.
- `provisionPersonalTenant` no longer inserts the user (Better Auth owns `users` and, via the
  account create, `external_identities`). It is idempotent (skips if a personal org already
  exists for the user) and **fails closed** if no tx client is in scope — refusing to create the
  account rather than risk an orphan user.

**Accepted coupling:** depends on `createOAuthUser` wrapping user+account in one transaction and
on `create.before` running in-transaction — pin `better-auth` (1.7.5) and re-verify on upgrade.
**Date:** 2026-09-17. **By:** user choice. Implemented in M2.

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

**Also from that review (open follow-ups, tracked for M2 completion):**
- **H-1 (deferred to live-DB step):** `external_identities.provider_email` / `email_verified`
  are not mapped, so the admin-bootstrap allowlist decision rides only on the in-memory ALS
  profile captured in `user.create.before`. Map those columns and back the admin decision with
  the persisted row (auditability + defense-in-depth). Deferred because it needs a schema/mapping
  change verifiable only against a live DB (none running yet).
- **M-1 (deferred to live-DB step):** add a real provider-double OAuth integration test proving
  the atomic invariant, plus a CI invariant query asserting no `users` row lacks a personal org.
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
