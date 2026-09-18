# ADR 004: Authentication library and session storage

- **Status:** Accepted — supersedes the prior "Open" placeholder
- **Date:** 2026-09-17 (resolved; original stub 2026-08-03)
- **Applies to:** M2 identity slice (control plane only; the `/v1/*` proxy authenticates
  with PATs and is out of scope here)

## Context

The implementation plan recommended Auth.js (NextAuth) but also assumed "hashed opaque
database session identifiers." That combination was never verified against how Auth.js
actually behaves, and the assumption risked accidentally motivating a hand-rolled session
protocol. This ADR resolves the library and session-strategy question against current
official documentation.

Constraints that drive the decision:

- Providers are **Google (OIDC) and GitHub (OAuth2)** only — no LinkedIn, no email/password
  (D-004). Roles are USER/ADMIN with admin bootstrap via `BOOTSTRAP_ADMIN_EMAILS`.
- Sessions are **browser / control-plane only**. They are never presented to `/v1/*`.
- The threat model requires **prompt, server-side session revocation** ("sign out
  everywhere", deactivation takes effect immediately), state/nonce/PKCE, a redirect
  allowlist, and **no unsafe cross-provider account linking by matching email**
  (`CLAUDE.md` rule 7; `THREAT_MODEL.md`).
- Fail-closed, no secret logging; production secrets via Azure Key Vault + managed identity.
- Existing Prisma models are `User` (with `normalizedEmail`, `displayName`, `status`,
  `locale`, `version` — deliberately **no** raw `email`/`emailVerified`/`image` columns) and
  `ExternalIdentity` (`provider` + `providerSubject` unique, `providerEmail`,
  `emailVerified`, `safe_metadata`). There is **no** session table today.
- The stack is **Next.js 15.5.7 App Router, React 19.1.1, Prisma 6.19.3, Node 22**, deployed
  to Azure; admin MFA/assurance is desired later.

Findings from current documentation (verified 2026-09):

- **Auth.js / NextAuth v5 status.** `next-auth@5` has never shipped a stable release; the
  installation instructions still use `next-auth@beta` (latest `5.0.0-beta.32`,
  2026-07). In September 2025 the project's maintenance was handed to the Better Auth team,
  who put Auth.js into **security-patch-only maintenance mode** and explicitly recommend new
  projects start on **Better Auth** unless they need stateless (no-DB) sessions.
  ([authjs.dev installation](https://authjs.dev/getting-started/installation),
  [migrating-to-v5](https://authjs.dev/getting-started/migrating-to-v5),
  ["Auth.js is now part of Better Auth"](https://better-auth.com/blog/authjs-joins-better-auth))
- **Auth.js session strategies.** With the JWT strategy the cookie holds an *encrypted JWE*
  containing the user data; with the database strategy the cookie holds only an opaque
  session-token that points at a `Session` row (`sessionToken`, `userId`, `expires`). Auth.js
  does **not** store a "hashed opaque id" — the DB `Session` row's `sessionToken` is the
  reference; the assumption in the old plan was simply wrong.
  ([session-strategies](https://authjs.dev/concepts/session-strategies))
- **Auth.js revocation.** JWT sessions cannot be revoked before expiry without an
  additional server-side blocklist; database sessions are revoked by deleting/modifying the
  row ("sign out everywhere"). Only the database strategy meets our threat model without a
  bespoke blocklist. ([session-strategies](https://authjs.dev/concepts/session-strategies))
- **Auth.js Prisma adapter shape.** `@auth/prisma-adapter` requires four models — `Account`,
  `Session`, `User`, `VerificationToken` — and expects `User` to carry `email`, `emailVerified`,
  `image`. This collides with our `User`/`ExternalIdentity` design and its `normalizedEmail`.
  ([adapters/prisma](https://authjs.dev/getting-started/adapters/prisma))
- **Auth.js OAuth checks / linking.** PKCE is the default check; state is applied for the
  authorization flow (state cookie), and OIDC providers add nonce; `allowDangerousEmailAccountLinking`
  defaults to `false`. However, advisory **GHSA-x445-f3h2-j279** (2026, affecting
  `next-auth <= 4.24.14` and `>= 5.0.0-beta.1 <= 5.0.0-beta.31`) reports that the state/nonce/PKCE
  check cookies are **not bound to the originating provider** when multiple providers plus
  logged-in account linking are configured — precisely our shape. Mitigation is to enable
  PKCE on every provider and stay patched.
  ([providers reference](https://authjs.dev/reference/core/providers),
  [GHSA-x445-f3h2-j279](https://github.com/nextauthjs/next-auth/security/advisories/GHSA-x445-f3h2-j279))
- **Better Auth.** TypeScript-first, actively developed, Vercel-backed, and the path the
  Auth.js maintainers now recommend. It stores **database sessions by default** (`session`
  table `id`, `token`, `userId`, `expiresAt`, `ipAddress`, `userAgent`; the cookie holds only
  the opaque server-side `token`). It exposes first-class server-side revocation
  (`auth.api.revokeSession`, `revokeOtherSessions`, `revokeSessions`) — exactly the
  "sign out everywhere / immediate deactivation" primitive we need — and drives Google/GitHub
  via its OAuth/OIDC core (Authorization Code + PKCE/state, OIDC nonce). Account linking is
  **off by default**; when enabled it is gated by an explicit `trustedProviders` allowlist and
  `allowDifferentEmails: false`, which satisfies "no unsafe email-based linking".
  ([session-management](https://better-auth.com/docs/concepts/session-management),
  [security](https://better-auth.com/docs/reference/security),
  [Prisma + Better Auth + Next.js](https://www.prisma.io/docs/guides/authentication/better-auth/nextjs))

## Decision

Adopt **Better Auth** as the control-plane identity library for the M2 sign-in slice, using
its **database (server-side) session strategy** with Google (OIDC) and GitHub (OAuth2) social
providers, integrated via the Prisma adapter and the `next-js` cookie plugin.

Rationale (against the ADR's own "prefer an established, supportable library; do not hand-roll"
constraint):

1. **Supportability is the tie-breaker.** Both Better Auth and Auth.js are established
   libraries that correctly implement Authorization Code + PKCE/state/nonce, so neither
   requires hand-rolling OAuth. But Auth.js v5 is a perpetual beta now in security-only
   maintenance whose own maintainers steer new projects elsewhere; committing a greenfield
   control plane to it is the weaker long-term bet. Better Auth is actively maintained and
   Vercel-backed.
2. **Database sessions natively satisfy the threat model.** The threat model demands prompt,
   server-side revocation. Better Auth stores sessions server-side by default and ships
   `revokeSession`/`revokeSessions` — no custom blocklist, no hand-rolled session protocol.
   The old plan's "hashed opaque id" assumption is dropped: the stored value is Better Auth's
   opaque `session.token`, and the cookie carries only that reference.
3. **Cleaner reconciliation with our schema.** Better Auth generates its own `session`
   (and `verification`) tables and maps its `account` concept onto our existing
   `ExternalIdentity` intent, letting us keep `User.normalizedEmail` and the
   `provider + providerSubject` uniqueness rather than bending `User` to the
   Auth.js-adapter's `email`/`emailVerified`/`image` expectations.

If a future review finds a blocking gap in Better Auth, **Auth.js v5 with the database
strategy is the sanctioned fallback** (documented under Alternatives). We do **not** adopt the
JWT strategy in either library, and we do **not** hand-roll sessions.

### Session strategy: database (server-side), not JWT

- Cookie carries only the opaque `session.token`; all session state lives in the `session`
  row. Revocation = delete/expire the row (single, other, or all sessions).
- Optional **cookie caching** may be enabled later for read performance, but with a short
  `maxAge` (≤ a few minutes) so that revocation and role/`status` changes take effect
  promptly; it must never be used to skip the DB check for security-sensitive transitions
  (deactivation, ADMIN grant/revoke).

### Reconciliation with the existing Prisma schema (high level)

- **Keep** `User` and `ExternalIdentity` as the canonical identity records; do not introduce
  the Auth.js `email`/`emailVerified`/`image` columns onto `User`.
- **Add** a `session` table (opaque `token`, `userId` → `users.id`, `expiresAt`, plus
  `ipAddress`/`userAgent`/timestamps) and a `verification` table required by Better Auth's core.
- **Map** Better Auth's `account` model onto the existing `ExternalIdentity` semantics
  (`provider`, `providerSubject`/account id, `providerEmail`, `emailVerified`), configuring
  the adapter's model/field mapping rather than duplicating a second linking table. Store OIDC
  `id_token`/refresh tokens only if a concrete need exists; default to **not** retaining
  provider tokens (threat model: minimal provider-token retention).
- Sign-in derives `User.displayName`/`locale`, sets `normalizedEmail`, and creates the
  personal `Organization` via the existing outbox flow. Role (USER/ADMIN) stays on the Hub
  side; ADMIN is granted only when the verified provider email is in `BOOTSTRAP_ADMIN_EMAILS`,
  recorded in `AuditEvent`.
- Exact columns and the adapter model-mapping are settled in the implementation PR against
  the running Better Auth version; this ADR fixes intent, not final DDL.

### OAuth safety configuration (must hold)

- **PKCE + state on every provider; nonce for Google (OIDC).** Enable PKCE explicitly on both
  providers (this also neutralizes the provider-confusion class from GHSA-x445-f3h2-j279).
- **Redirect allowlist / trusted origins.** Configure the canonical Hub origin(s) as the only
  trusted origins / callback URLs; reject others. No client- or env-selected redirect targets.
- **Account linking off by default.** Do **not** auto-link by email. If cross-provider linking
  is ever enabled, require an authenticated, deliberate link action, an explicit
  `trustedProviders` allowlist, `allowDifferentEmails: false`, and a **verified** provider
  email — never silent linking on sign-in. This directly enforces `CLAUDE.md` rule 7.
- **Secure cookies.** In production: `Secure`, `HttpOnly`, `SameSite=Lax`, host-scoped
  (`__Host-`/`__Secure-`-style) cookies, served only over HTTPS behind the Azure edge; the
  strong Better Auth server-side secret held in Key Vault.
- **CSRF.** State on the OAuth flow plus `SameSite=Lax` session cookies; POST-based sign-out.
  Do not disable the library's CSRF/origin checks.

### Revocation approach

Server-side session rows are the source of truth. User deactivation, ADMIN revocation, and
"sign out everywhere" call `revokeSessions`/`revokeOtherSessions` (or delete the rows) and are
audited. No JWT blocklist is needed because we never issue stateless JWT sessions.

## Alternatives

- **Auth.js / NextAuth v5, database strategy (sanctioned fallback).** Equivalent OAuth
  correctness and DB-session semantics, and a large install base. Rejected as the primary
  choice because it is a perpetual beta in security-only maintenance, its adapter's `User`
  shape conflicts with ours, and advisory GHSA-x445-f3h2-j279 targets our exact
  multi-provider + linking configuration. Remains a low-effort fallback if Better Auth is
  found unsuitable during implementation.
- **JWT sessions (either library).** Rejected: no prompt server-side revocation without a
  bespoke blocklist, which is precisely the hand-rolled complexity this ADR avoids, and it
  fails the threat model's immediate-deactivation requirement.
- **Managed identity platform (Clerk / Auth0 / WorkOS / Azure Entra External ID).** Would
  offload MFA and admin assurance and fits the Azure target (Entra External ID especially).
  Deferred for v1: adds an external dependency, per-MAU cost, and data-residency/vendor
  considerations for a control plane that only needs Google + GitHub now. Better Auth's
  plugin model (and the option to front admin sign-in with Entra later) keeps this path open
  without committing to it in v1.
- **Hand-rolled OAuth/session code.** Rejected outright by policy and risk.

## Consequences

- A supported library owns Authorization Code + PKCE/state/nonce, cookie security, and CSRF;
  we configure rather than implement these.
- A session-storage dependency and new tables (`session`, `verification`) enter the schema in
  M2; the foundation slice remains free of auth code as before.
- `User`/`ExternalIdentity` stay canonical; the adapter is mapped onto them, avoiding a
  divergent second user model.
- The proxy/data plane is unaffected — `/v1/*` continues to authenticate with PATs (D-005),
  never sessions.
- We take on tracking Better Auth releases/advisories (as we would for any dependency),
  including pinning and reviewing upgrades.

## Security considerations

Covered above and non-negotiable: state/nonce/PKCE on every provider; redirect/trusted-origin
allowlist; no unsafe email-based cross-provider linking (linking off by default; if enabled,
verified-email + `trustedProviders` + `allowDifferentEmails:false`); session fixation avoided
by issuing a fresh server-side session on sign-in; short expiry with server-side
expiry/rotation; **immediate** server-side revocation on deactivation / ADMIN change /
"sign out everywhere"; CSRF via state + `SameSite=Lax` + POST sign-out; secure host-scoped
`HttpOnly`/`Secure` cookies; minimal provider-token retention (default: do not persist
provider access/refresh/id tokens); the session secret and provider client secrets held in
Azure Key Vault, never logged. Admin MFA/assurance is a documented follow-up, not a v1 gate.

## Follow-up decisions (implementation PR)

- Pin the Better Auth (and adapter) version; confirm the generated `session`/`verification`
  DDL and the `account`→`ExternalIdentity` field mapping against that version; add a Prisma
  migration through the single migration authority.
- Set concrete session-expiry SLOs (`expiresIn`, `updateAge`) and decide whether cookie
  caching is enabled (and its short `maxAge`), ensuring security transitions still hit the DB.
- Wire `BOOTSTRAP_ADMIN_EMAILS` → ADMIN grant with an `AuditEvent`, gated on a verified
  provider email.
- Define admin MFA/assurance (e.g. fronting admin sign-in with Azure Entra External ID or a
  Better Auth MFA plugin) as a later step.
- Add deterministic tests with provider doubles (no live Google/GitHub calls) covering
  sign-in, linking-disabled behavior, revocation/deactivation, and cookie-security assertions.
- Re-verify GHSA-x445-f3h2-j279 status and confirm PKCE-on-all-providers before merge.
