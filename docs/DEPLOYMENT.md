# Sculpin Hub — Deployment

Deployment intent for the Hub. Detailed design is in the long-form plan
([`sculpin-knowledge-hub-implementation-plan.md`](sculpin-knowledge-hub-implementation-plan.md),
§14) and ADR [`adr/002-foundation-runtime-and-toolchain.md`](adr/002-foundation-runtime-and-toolchain.md).
This is the operational summary; it will be filled in during M8.

## Target

- **Azure** is the intended production target, keeping application layers portable where
  practical. Separate workloads: public **web** (Next.js), **proxy** (data plane), **worker**.
- Managed PostgreSQL; managed Redis only if/when rate limiting needs a shared atomic store
  (PG-backed limiting is the initial approach).
- **Secrets via Azure Key Vault + managed identity.** No secrets in images, IaC, or `.env`
  committed to the repo. `OPENAI_DEV_API_KEY` and `PAT_HASH_SECRET` live only in the secret
  manager and are injected as process env at runtime.

## Connectivity to Sculpin

Sculpin's OpenAI surface (`agent-api`, port 8001) must NOT be exposed directly to the public
internet. Use private networking / VPN / application proxy / outbound-initiated secure tunnel
between the Hub proxy and Sculpin. The internal upstream URL is never returned to clients.

## Images

Built from repo root, non-root users, no baked secrets:

```bash
docker build -f apps/web/Dockerfile   -t sculpin-hub-web   .
docker build -f apps/proxy/Dockerfile -t sculpin-hub-proxy .
docker build -f apps/worker/Dockerfile -t sculpin-hub-worker .
```

Prisma Client is generated at build time using a build-only, non-secret `DATABASE_URL`.

## Migrations & config

- Prisma Migrate is the single migration authority; run `db:migrate:deploy` as a release job.
- Validate required env at startup and fail closed on missing/invalid config
  (`packages/config`). Production DB safety check rejects localhost / `local-development-only`.

## To be completed in M8

IaC modules, environments (dev/staging/prod), autoscaling, WAF/TLS termination, zero-downtime
strategy, rollback, backup/restore, secret rotation. See [`OPERATIONS.md`](OPERATIONS.md).
