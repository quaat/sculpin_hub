# ADR 001: Monorepo and workload boundaries

- **Status:** Accepted for foundation
- **Date:** 2026-08-03

## Context

The repository had planning material but no application. The control plane, public web, streaming data plane, and background work have different traffic and failure characteristics without yet justifying domain microservices.

## Decision

Use a pnpm/Turborepo TypeScript monorepo. Build `apps/web` (Next.js web/control foundation), `apps/proxy` (Fastify data plane), and `apps/worker` (background runtime) as separate deployables. Share narrow packages for contracts, configuration, database lifecycle, jobs, and observability. The production proxy registry is empty.

## Alternatives

A single Next.js process couples API and UI scaling. Many microservices create premature distributed consistency. Separate repositories duplicate contracts and delivery overhead.

## Consequences

Workloads scale and deploy independently while one repository preserves reviewable contracts. Package boundaries require discipline and CI builds all dependants.

## Security considerations

The split supports least-privilege identities, network policies, and isolated proxy limits. Shared packages must not become channels for secrets or browser/server code confusion.

## Follow-up decisions

Select production compute/networking and database permissions in the infrastructure ADR; certify routes before registering them.
