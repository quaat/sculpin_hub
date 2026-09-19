# Sculpin Hub — Threat Model

Broker-focused threat model. The long-form plan
([`sculpin-knowledge-hub-implementation-plan.md`](sculpin-knowledge-hub-implementation-plan.md),
§9/§11) enumerates the full catalogue; this file highlights the trust boundaries and the
threats most specific to the Hub-as-broker, with the controls that must never regress.

## Trust boundaries

1. **Browser ↔ Web (control plane).** OAuth sign-in, dashboard, admin. Sessions, CSRF, secure
   cookies.
2. **OpenAI client ↔ Proxy (data plane).** PAT-authenticated `/v1/*` traffic. This is the
   highest-value boundary: it authenticates, authorizes, meters, and forwards to Sculpin.
3. **Proxy ↔ Sculpin upstream.** Server-side only. The Hub holds `SCULPIN_UPSTREAM_API_KEY`;
   clients never see it or the internal `SCULPIN_UPSTREAM_URL`.
4. **Services ↔ PostgreSQL.** Tenant-scoped access; a DB leak must not disclose usable secrets.

## Priority threats & required controls

| Threat                                | Control (must hold)                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Stolen/leaked PAT usable from DB dump | Store only HMAC-SHA-256 keyed digest; `PAT_HASH_SECRET` outside DB; raw token shown once (D-005) |
| Upstream credential leakage           | `SCULPIN_UPSTREAM_API_KEY` never in DB/logs/usage/errors/responses; single injection module      |
| Blind proxy / route smuggling         | Default-DENY `/v1/*` registry; only reviewed routes registered; no env/client route selection    |
| SSRF / internal URL disclosure        | No user/admin-supplied upstream URLs; internal Sculpin URL never returned to clients             |
| Credential/prompt leakage via logs    | No body logging by default; never log tokens, prompts, or responses                              |
| Usage-accounting race (over-grant)    | Atomic quota reservation; test concurrent last-quota requests                                    |
| OAuth account takeover                | state/nonce/PKCE, redirect allowlist, no unsafe email-based linking                              |
| Header injection / hop-by-hop leakage | Header allowlist; strip hop-by-hop; never forward client Authorization/cookies upstream          |
| Privilege escalation                  | Server-side USER/ADMIN authz; auditable admin bootstrap via `BOOTSTRAP_ADMIN_EMAILS`             |
| Oversized bodies / slow clients (DoS) | Body size limits (proxy `PROXY_BODY_LIMIT_BYTES`), timeouts, bounded shutdown                    |
| Cross-tenant / IDOR                   | Tenant-scoped queries on every control-plane read/write                                          |

## Non-negotiables

Mirror of `CLAUDE.md`: fail closed for authorization; never persist/log secrets, prompts, or
responses; Sculpin upstream is read-only; usage events carry no raw PAT, OAuth token, upstream
key, complete body, prompt, or generated response.

## Open items

- Resolve session/storage model (ADR 004) before M2.
- Rate-limiting substrate (PG-backed initially; Redis later) — confirm during M6/M7.
- Confirm Sculpin auth expectations from M0 output before finalizing credential injection.
