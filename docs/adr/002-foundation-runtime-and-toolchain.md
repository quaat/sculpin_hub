# ADR 002: Foundation runtime and toolchain

- **Status:** Accepted for foundation; dependency versions require periodic review
- **Date:** 2026-08-03

## Context

The slice needs reproducible strict TypeScript builds with a current supported runtime and no speculative platform SDKs.

## Decision

Pin Node.js 22.22.2, pnpm 10.28.1, strict TypeScript, ESLint flat configuration, Prettier, Vitest, Next.js for web, and Fastify for proxy. Exact dependency versions and the lockfile are committed. PostgreSQL access uses the small `pg` client layer in this model-free slice; Prisma is deferred until the first meaningful domain migration, because generating a client with meaningless tables would create false domain commitments.

## Alternatives

Unpinned versions are irreproducible. Installing Auth.js, Stripe, Azure SDKs, Prisma, or UI libraries now adds unused attack surface. A placeholder Prisma model violates the no-invented-tables constraint.

## Consequences

The baseline is small and testable. The next schema PR must re-evaluate supported Prisma/Node versions, add Prisma deliberately, and migrate from the narrow `Database` seam.

## Security considerations

Lock dependencies, scan updates, use strict compilation, validate configuration, and keep runtime images non-root. Version selection must be rechecked against official release/support documentation when network access is available.

## Follow-up decisions

Record Prisma/query-layer selection with the first domain schema; establish dependency update ownership.
