# ADR 007: Personal Access Tokens (mint-once, keyed-digest-at-rest)

## Status

Accepted. Realizes `CLAUDE.md` rule 2 and the M5 milestone
([`IMPLEMENTATION_PLAN.md`](../IMPLEMENTATION_PLAN.md)). Builds on the M2 authz
primitives (ADR 006 / `requireUser`) and the M4 entitlement gate
([D-015](../DECISIONS.md#d-015)).

- **Date:** 2026-09-20
- **Applies to:** M5 PAT lifecycle. The control plane (`apps/web`) mints,
  lists, and revokes; the data plane (`apps/proxy`, M6) will authenticate `/v1/*`
  callers by resolving a PAT to an identity. The upstream Sculpin key is a
  separate credential and is NEVER a PAT (rule 3).

## Context

Users call the Hub's OpenAI-compatible `/v1/*` endpoint with a standard bearer
token from an OpenAI client. That token must be a Hub-issued **Personal Access
Token**, not a session cookie or an OAuth token. The security mission fixes the
hard constraints (`CLAUDE.md` rule 2): a fixed wire format, a CSPRNG secret
shown exactly once, never stored/logged/recoverable, only an **HMAC-SHA-256
keyed digest** persisted (key OUTSIDE the DB), constant-time verification, and
the property that a database leak yields no usable credential.

## Decision

### Wire format

`sclp_pat_<public-id>_<secret>` (`PAT_PREFIX = "sclp_pat_"`).

- **public-id:** 22 base62 chars (~131 bits). An unauthenticated **lookup
  handle**, stored in cleartext and uniquely indexed. Not a secret.
- **secret:** 43 base62 chars (~256 bits). The bearer proof. Never stored.

Both parts are drawn from `crypto.randomBytes` with rejection sampling
(bytes `>= 248` discarded) so `byte % 62` is unbiased. Parsing
(`parsePatToken`) splits on the FIRST `_` after the prefix and validates both
segments against strict base62 length patterns; any deviation returns
`undefined` — callers MUST treat every malformed token identically to an auth
failure (no parsing oracle).

### At rest (the core control)

The `personal_access_tokens` table stores `secret_hash =
base64(HMAC-SHA-256(secret, PAT_HASH_SECRET))` and NEVER the raw secret. The
HMAC key `PAT_HASH_SECRET` lives in validated config
(`z.string().min(32).max(512)`), OUTSIDE the database (Key Vault in prod). A
keyed digest (not a bare hash) means an attacker who exfiltrates the table still
cannot brute-force high-entropy secrets, and — critically — cannot mint or
replay tokens without also stealing the key. The stored digest is not itself a
valid token (base64, wrong shape), so a DB dump is not directly replayable.

### Verification (constant time)

`verifyPatSecretHash` compares the candidate's keyed digest to the stored digest
with `crypto.timingSafeEqual` over equal-length buffers. `authenticate`:

1. parses the token (well-formed or not);
2. looks up ONLY on `public_id`, with a JOIN that re-derives an **active**
   user, **active** organization, and **active** membership, and requires the
   PAT itself `status = 'active'` and `expires_at IS NULL OR expires_at > now()`
   (fail closed — a valid secret is insufficient if any link is inactive);
3. computes an HMAC on EVERY path — including parse/lookup misses, against a
   fixed dummy digest — so a missing public-id and a wrong secret are
   indistinguishable by timing;
4. returns a single opaque `undefined` on any failure; on success touches
   `last_used_at` and returns `{ patId, userId, organizationId }`.

### Lifecycle & scope

- **Mint:** gated by `requireUser`; scoped to the caller's PERSONAL
  organization (team PATs are out of scope for v1). Returns the raw token
  exactly once alongside the metadata record.
- **List / revoke:** owner-scoped. `revoke` flips `status='revoked'` only for an
  `active` token owned by the caller (idempotent; another user cannot revoke it).
  Revocation and expiry both immediately remove the row from the active set.
- Records surfaced to callers carry neither the secret nor the digest.

## Consequences

- A database leak yields **no** usable bearer credential: the plaintext secret
  does not exist, and the keyed digest cannot be reversed or replayed without
  `PAT_HASH_SECRET` (which is not in the DB).
- Authorization is always re-derived from canonical rows, so deactivating a
  user, suspending an org, or ending a membership disables the PAT on the next
  request without touching the token.
- `PAT_HASH_SECRET` is load-bearing and must be highly available and rotated
  with care: rotating it invalidates every existing PAT (they would all fail
  verification). A future rotation story (dual-key verify window) would need its
  own change; v1 treats the key as stable.
- The data-plane authentication path (M6) will consume `authenticate` and must
  keep the "single opaque failure" contract (no reason leakage to clients).

## Verification

- **Domain unit** (`packages/domain/src/index.test.ts`): format round-trips;
  `parsePatToken` rejects every malformed shape as `undefined`; name validation.
- **Data-layer unit** (`packages/db/src/pat.test.ts`, no DB): HMAC is a
  deterministic keyed digest; constant-time verify is true only for the exact
  secret+key; mint stores ONLY the digest (raw secret never in INSERT params, the
  stored digest is not a valid token, the returned record leaks neither);
  `authenticate` denies malformed tokens without any DB lookup, denies a wrong
  secret without touching `last_used`, and never returns a reason.
- **Integration** (`packages/db/src/pat.integration.test.ts`, ephemeral
  Postgres): the persisted row contains no plaintext secret and
  `secret_hash = HMAC(secret, key)`; the stored digest cannot authenticate;
  revocation and expiry stop authentication; a deactivated user / suspended org
  fails closed; listing exposes no secret.
- **Independent security review** (opus, read-only) required before sign-off — a
  security-sensitive implementer never signs off its own work.
