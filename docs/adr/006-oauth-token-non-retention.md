# ADR 006: OAuth provider tokens are never persisted

## Status

Accepted. Realizes the "minimal provider-token retention (default: do not
persist provider access/refresh/id tokens)" intent stated in
[ADR 004](004-auth-session-storage-open-decision.md) and enforces `CLAUDE.md`
rule 5.

- **Date:** 2026-09-19
- **Applies to:** M2 identity slice (control plane). The `/v1/*` data plane is
  unaffected — it authenticates with PATs and injects the Sculpin upstream key.

## Context

The Hub uses Google (OIDC) and GitHub (OAuth2) **only to authenticate a
person**. It never calls a provider API on the user's behalf (no Google/GitHub
resource access, no offline refresh). It therefore has no functional need for
the provider `access_token`, `refresh_token`, `id_token`, their expiry
timestamps, `scope`, or a local `password`.

Better Auth's Prisma account adapter, however, will populate those columns on
sign-up and — on a returning sign-in — call `updateAccount` to refresh them.
An earlier iteration left the columns present, producing a contradiction: the
code comments claimed tokens were not persisted while the schema retained
columns that Better Auth would fill. Retaining unused provider credentials is a
standing liability: a database leak would yield **usable** provider tokens, and
the tokens would flow through backups, replicas, and audit surfaces for no
benefit.

Two options were considered:

1. **Retain** the tokens with envelope encryption (key outside the DB),
   log/response redaction tests, and a documented refresh/rotation policy.
2. **Prune** the columns entirely so the credentials never exist at rest.

## Decision

**Prune.** The `external_identities` table drops `access_token`,
`refresh_token`, `id_token`, `access_token_expires_at`,
`refresh_token_expires_at`, `scope`, and `password` (migration
`20260919140000_prune_oauth_tokens`). We keep only the fields the Hub actually
uses to identify a person and back the admin-bootstrap decision:
`provider`, `provider_subject` (unique together), `provider_email`,
`email_verified`, and `safe_metadata`.

Because a security control that depends solely on a dropped column is fragile,
the prune is backed by **three layers of defense** so no token value is ever
written even if the schema drifts:

1. **Schema (authority):** the columns do not exist. Prisma Migrate is the
   single migration authority (ADR 005); a re-introduction would be a reviewed,
   visible DDL change.
2. **Adapter input stripping:** `databaseHooks.account.create.before` sets
   `accessToken`/`refreshToken`/`idToken`/`*ExpiresAt`/`scope`/`password` to
   `undefined`. Better Auth's `transformInput` skips `undefined`-valued fields,
   so nothing is offered to the writer in the first place.
3. **No refresh-on-sign-in:** `account.updateAccountOnSignIn = false` disables
   the returning-sign-in `updateAccount` path that would otherwise write fresh
   tokens on every login.

### Cost: `advanced.database.validateSchema = false`

Better Auth's Prisma adapter runs a start-up schema check that expects a column
for **every** field it *could* write, including the token fields. With the
columns dropped, that check fails, so we set
`advanced.database.validateSchema = false`. This is a deliberate, documented
trade: we give up Better Auth's built-in schema drift check and rely instead on
Prisma Migrate (ADR 005) plus the integration tests below to catch drift. The
rationale is recorded inline in `apps/web/app/lib/auth.ts`.

### Provider email + verified flag (H-1)

`provider_email` and `email_verified` ARE persisted (via Better Auth
`account.additionalFields`, populated from the verified profile captured in the
sign-up transaction). These are not credentials; they back the admin-bootstrap
role decision with a durable, auditable row rather than a transient claim.

## Consequences

- A database leak yields **no** usable provider credentials — the strongest form
  of the control (the data does not exist), not merely encrypted-at-rest.
- The Hub cannot later call a provider API on the user's behalf without a
  reviewed schema change plus a new consent/scope story. This is intended; if
  such a need appears it must come with its own ADR (encryption, rotation,
  redaction), reversing this one.
- We own tracking Better Auth's account-write behavior across upgrades: the
  input-stripping hook and `updateAccountOnSignIn:false` are coupled to library
  internals. `better-auth` is pinned; re-verify on upgrade.
- `validateSchema:false` means schema/library drift is caught by Prisma Migrate
  and tests, not by Better Auth's own check.

## Verification

- Deterministic unit test (`apps/web/app/lib/auth.test.ts`) asserts the
  account-create hook returns the identity fields but strips every token/
  credential field to `undefined` and sets `email_verified`.
- Schema/migration under `packages/db/prisma` proves the columns are absent
  (migration `20260919140000_prune_oauth_tokens` reverses `..120000`).
- Integration coverage (M-1) exercises real sign-up against an ephemeral
  Postgres and asserts no token columns exist / no token values are stored.
