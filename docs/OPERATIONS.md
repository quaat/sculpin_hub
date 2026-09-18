# Sculpin Hub — Operations

Operational runbook scaffold. Detailed observability/SLO design is in the long-form plan
([`sculpin-knowledge-hub-implementation-plan.md`](sculpin-knowledge-hub-implementation-plan.md),
§13). Populated as milestones land (esp. M7 usage/analytics and M8 deploy).

## Health & readiness

- Web: `/api/health/live`, `/api/health/ready`. Proxy: `/health/live`, `/health/ready`.
- Readiness returns `503` when PostgreSQL cannot answer (`SELECT 1`, bounded query timeout).
  Public readiness exposes only `ready`/`not_ready` + service name — dependency names stay
  internal to reduce infrastructure disclosure. Redis is not yet a readiness dependency.

## Logging & redaction

- Structured logs with request/correlation IDs. **No body logging by default.**
- Redaction covers `upstreamCredential` / `upstream_credentials` and must extend to any PAT,
  OAuth token, prompt, or model response. Never log `OPENAI_DEV_API_KEY`.

## Metrics to track (as they come online)

Token-auth failure rate, proxy latency & upstream latency, streaming duration, error rate by
normalized category, quota/reservation leaks, subscription-state drift, outbox backlog.

## Suggested SLOs (to ratify in M8/M9)

Control-plane availability, proxy availability, proxy latency overhead, PAT-revocation
propagation time, usage-accounting accuracy.

## Routine procedures

- **DB migration:** apply reviewed Prisma migrations via `db:migrate:deploy` release job;
  verify with `db:migration:test` against a disposable DB.
- **Secret rotation:** rotate `OPENAI_DEV_API_KEY` and `PAT_HASH_SECRET` in Key Vault. Rotating
  `PAT_HASH_SECRET` invalidates existing PAT digests — plan a re-issue/rotation window.
- **Admin bootstrap:** first admin via `BOOTSTRAP_ADMIN_EMAILS`; every admin action audited.
- **Local deps:** `docker compose up -d postgres redis`; reset with `down --volumes` (destructive).

## Incident notes

- Proxy returning `unsupported operation` for a `/v1/*` route is expected fail-closed behavior
  for unregistered routes — add routes only via reviewed code, never config.
- If usage appears over-granted under load, suspect a non-atomic quota path; reservations must
  be atomic (see [`THREAT_MODEL.md`](THREAT_MODEL.md)).

## To be completed

Dashboards, alert routing, on-call runbook, backup/restore drills, DR, GDPR export/delete flows.
