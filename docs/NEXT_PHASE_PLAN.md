# Sculpin Hub — Next Phase Plan: Path to a Real Test-Case Scenario

_Created: 2026-09-19_

Companion to the milestone tracker ([`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md)) and the
live snapshot ([`STATUS.md`](STATUS.md)). This document defines the concrete, phased path from
"OAuth sign-in works" (M2 live-verified) to "a real user can drive Sculpin through the Hub with
a stock OpenAI client."

## Target scenario

The end-to-end flow we are enabling:

1. A user signs in with Google/GitHub (**done — M2 live**).
2. The user mints a Personal Access Token (PAT) in the Hub UI.
3. The user points a stock OpenAI client at the Hub's `/v1` base URL, using the PAT as the API
   key.
4. The Hub **authenticates** the PAT, **authorizes** it (entitlement + quota), **meters** the
   call, and **proxies** the accepted request to Sculpin — injecting the upstream credential,
   never forwarding the caller's PAT/cookies, never leaking the internal Sculpin URL.
5. The Hub returns Sculpin's response (including SSE streaming) byte-for-byte.

This is a thin vertical slice across milestones **M6** (proxy), **M5** (PATs), **M3**
(catalogue), and **M7** (metering). All work inherits the fail-closed security rules in
[`../CLAUDE.md`](../CLAUDE.md).

## Current baseline (2026-09-19)

- **M2 identity:** live-verified. Google OAuth sign-in works end-to-end; atomic personal-tenant
  provisioning runs on first sign-in. Web `:3002`, proxy `:3001`, worker, Postgres, Redis up.
- **Proxy `/v1/*`:** a **dev-only blind forwarder** is currently wired
  (`apps/proxy/src/forward.ts`). It is gated to `NODE_ENV=development` and cannot activate in
  production, but it forwards the caller's headers verbatim and injects no upstream credential —
  it violates CLAUDE.md rules 1/3/4 and is a temporary bring-up hack. **Phase A deletes it.**
- **Schema tradeoff:** the Full Better Auth migration retains provider tokens in
  `external_identities` (explicit product decision), relaxing minimal-token-retention (rule 5).

## Blocker to resolve first

The **Sculpin tenant-mapping decision** is still `OPEN` in [`DECISIONS.md`](DECISIONS.md). It
determines how a Hub user/org maps onto Sculpin's agent/knowledge-base surface and therefore
shapes the catalogue and entitlement model in Phase C. Close it before starting Phase C.

## Phases

### Phase A — Safe real proxy (M6 core)

Replace the dev-only blind forwarder with the reviewed, fail-closed data plane.

- Delete `apps/proxy/src/forward.ts` and the dev-only `/v1/*` catch-all wiring in `server.ts`.
- Register **exactly** the confirmed Sculpin routes in the production registry, via reviewed
  code only (never from env/client input):
  - `GET /v1/models`
  - `POST /v1/chat/completions` (SSE passthrough when `stream: true`, framed
    `data: <json>\n\n` / `: keep-alive\n\n` / `data: [DONE]`).
- Centralize upstream-credential handling in **one** module:
  - Strip the caller's `Authorization`, cookies, and all hop-by-hop headers.
  - Set `Authorization: Bearer ${OPENAI_DEV_API_KEY}` (env `OPENAI_COMPAT_DEV_API_KEY` upstream
    per M0 discovery). This credential never touches the DB, browsers, logs, or responses.
  - Fixed upstream base URL from validated config; no client-influenced target (no SSRF); the
    internal Sculpin URL is never leaked to clients.
- Map the public model alias to the upstream agent id at the edge (thin, hard-coded until M3).

**Acceptance:** unregistered `/v1/*` routes return the fail-closed error; the two real routes
proxy successfully; SSE streams byte-for-byte; a test proves no caller PAT/cookie/Authorization
is forwarded upstream and no internal URL appears in any client-visible surface.

### Phase B — PAT authentication (M5)

- Generate PATs as `sclp_pat_<public-id>_<secret>`; secret is CSPRNG, shown once, never stored
  or logged.
- Store **only** an HMAC-SHA-256 keyed digest of the secret (key `PAT_HASH_SECRET`, kept OUTSIDE
  the DB). Verify in constant time.
- Gate every `/v1/*` request on a valid PAT resolving to an active user + org context; reject
  otherwise (fail closed).
- UI: mint / list / revoke PATs; revocation takes effect immediately.

**Acceptance:** a DB dump contains no usable bearer credential; logs contain no token values;
revoked/expired PATs are rejected; dedicated security review passed.

### Phase C — Catalogue + minimal entitlement (M3 + thin M4)

- Admin-published catalogue: public model alias → upstream agent id map. Only the alias is
  exposed to clients; internal Sculpin ids/config are never leaked.
- Minimal entitlement so authorization is not "any valid PAT calls anything": grant a trial
  subscription during personal-tenant provisioning; resolve entitlement as the union of active
  subscriptions.

**Acceptance:** admins publish/unpublish entries; a PAT without an entitlement covering the
requested alias is denied; internal ids never appear in client responses.

### Phase D — Metering + atomic quota (M7)

- Emit usage events carrying no secrets, prompts, bodies, or upstream key.
- Reserve trial quota **atomically** (no read-compare-increment); test concurrent last-quota
  attempts.
- Surface basic usage/audit views.

**Acceptance:** quota holds under concurrency at the last unit; usage events are free of
sensitive content; audit trail present.

## Minimum viable real test

**Phase A + Phase B** together are sufficient for a first real test: a signed-in user mints a
PAT and drives `/v1/chat/completions` through the Hub to Sculpin with the upstream credential
injected. Phases C and D make that test **governed** (correct model routing + entitlement +
quota) rather than an open pipe, and are required before exposing the Hub beyond a controlled
trial.

## Manual prerequisites (operator)

- SSH tunnel (or network path) placing Sculpin at the configured `SCULPIN_UPSTREAM_URL`.
- Google OAuth redirect URI includes `http://localhost:3002/api/auth/callback/google`.
- Real GitHub OAuth credentials if GitHub sign-in is wanted (currently placeholders).
- `OPENAI_COMPAT_DEV_API_KEY` (or the hashed-key path) available to the proxy for upstream auth.
