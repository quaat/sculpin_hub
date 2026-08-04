# ADR 005: Prisma tenant persistence and transactional outbox

- Status: Accepted
- Date: 2026-08-04

## Context

The first domain data must establish tenant isolation and reliable side effects before authentication or public routes are enabled. The existing `pg` pool remains useful for bounded health checks and for SQL whose concurrency semantics must be directly reviewable.

## Decision

Prisma's schema and generated client are introduced as the intended typed persistence client. Versioned, forward-only SQL migrations are authoritative and are deployed separately from application startup. A single process-owned database lifecycle is required; callers must not create untracked Prisma or `pg` pools. During this transition the existing pool owns readiness, transactions, and the outbox. Prisma must use that same database target and must not become a second long-lived application pool until the health seam is consolidated.

PostgreSQL generates UUIDs with `gen_random_uuid()`. This keeps IDs available within a transaction without trusting an application host's clock or random source.

Tenant-owned repository operations require a `TenantContext` and always begin predicates and relevant indexes with `organization_id`. Global identity lookup is a separate repository. Application-enforced tenant repositories remain mandatory even if row-level security is later added. RLS is deferred until connection/session scoping and operational recovery procedures are designed and tested.

Personal-organization creation, membership, audit, and outbox insertion occur in one database transaction. Audit events are append-only and reject updates and deletes at the database boundary. Summaries and outbox payloads are minimal and must not contain credentials, raw identity claims, provider tokens, or request bodies.

Outbox consumers claim bounded batches with `FOR UPDATE SKIP LOCKED`. A claim records its owner, increments attempts atomically, and expires after a lease. Only the owning worker may complete it. Processed and terminal events cannot be reclaimed; retryable outcomes clear ownership and set a future availability time. Event payloads are validated before dispatch.

Users, organizations, and memberships use restrictive foreign keys. Audit and outbox history never cascade-delete. Domain records are deactivated rather than physically removed. Audit retention is indefinite pending a compliance policy; processed outbox events may be archived only through a separately reviewed retention job.

## Migrations, testing, and rollback

CI applies migrations to an empty real PostgreSQL database, reapplies them to prove idempotence, validates the schema/client, runs constraint and tenant-isolation tests, and exercises concurrent claims. Production migrations run as an explicit deployment step, never on workload startup.

Schema rollback uses a forward corrective migration and application rollback. Destructive down migrations are not automated because they risk erasing audit history. Releases must remain compatible with the preceding schema during rollout.

## Consequences

Infrastructure SQL remains visible where transactional or leasing behavior matters, while application workloads cannot issue arbitrary persistence queries. Authentication, OAuth callbacks, sessions, and all Sculpin production routes remain out of scope.
