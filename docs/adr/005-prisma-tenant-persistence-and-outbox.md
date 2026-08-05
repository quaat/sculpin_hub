# ADR 005: Prisma tenant persistence, audit, and transactional outbox

## Status

Accepted.

## Decision

Prisma ORM is introduced now because the repository has reached the first durable domain migration: users, external identities, organizations, memberships, audit events, and outbox events. Prisma Migrate is the single migration authority; reviewed SQL lives under `packages/db/prisma/migrations`, deployment uses `prisma migrate deploy`, and `_prisma_migrations` is the only migration history table. Raw SQL remains only for PostgreSQL features that Prisma cannot express or should not hide: check-heavy invariants, append-only audit triggers, partial claim indexes, and `FOR UPDATE SKIP LOCKED` outbox claiming.

`packages/db` owns persistence lifecycle. Applications receive a `Database` object from `createDatabase`/`getDatabase`; they must not create ad-hoc Prisma clients or pg pools. The lifecycle explicitly owns one bounded pg pool for readiness and transactional SQL plus one statically imported generated Prisma Client for generated schema access, and `close()` is idempotent. The pg pool defaults to `max=10`; the Prisma client factory injects `connection_limit=5` into its PostgreSQL URL when the caller has not set a limit. Each workload instance therefore budgets up to 15 PostgreSQL connections by default. This intentionally retains separate pools until a supported shared Prisma PostgreSQL adapter is adopted and tested.

UUIDs are generated in PostgreSQL with `gen_random_uuid()`. This deviates from the implementation plan's longer-term preference for time-sortable UUIDs because PostgreSQL 17 does not provide a standard UUIDv7 generator without an additional extension; migration safety and portability take precedence for this baseline.

Tenant-owned repositories require `TenantContext` as their first argument. Global identity lookup by `(provider, providerSubject)` is isolated in a separate identity repository and does not weaken tenant repository contracts. Application-enforced tenant repositories are mandatory even if PostgreSQL RLS is added later. RLS is explicitly deferred until the tenancy model and service-role requirements are proven by more domain branches.

External identity `safe_metadata` is constrained at the database boundary to the version-1 allow-list (`schemaVersion`, `issuer`, and `tenant`) and rejects unknown, nested, or credential-like keys.

Personal organizations store `personal_owner_user_id` on the organization row. A partial unique index on that column for `type = 'personal'` guarantees one personal organization per user while ordinary membership rows still allow future team memberships.

Audit events are append-only. UPDATE and DELETE are rejected by triggers, summaries must be JSON objects or null, and user actors must be members of the organization through a composite foreign key. System actors remain supported for future maintenance jobs.

Outbox events use an event schema registry keyed by `eventType` and `schemaVersion`. The initial event is `personal_organization.created` version 1 and contains only opaque `organizationId` and `userId` values. Payloads are checked for exact shape and nested secret-like keys before insertion and again at claim time. A narrow PostgreSQL trigger also rejects direct SQL attempts where the event type/schema, payload UUIDs, aggregate identifiers, aggregate type, or owner membership do not match. Invalid stored payloads are terminalized inside the claim transaction so poison rows do not strand valid events in the same batch.

Claims use the database clock (`now()`) for eligibility and lease comparisons. Claiming locks an ordered bounded batch with `FOR UPDATE SKIP LOCKED`, validates payloads while the rows are locked, terminalizes poison rows, and atomically records owner, lease, attempt count, and version for valid rows. Retryable completion clears the claim and schedules a future availability time; if attempts are exhausted, the event becomes terminal with `attempts_exhausted`. Completion returns explicit internal statuses, wrong-owner completion fails, and already-settled rows are treated as explicit idempotent outcomes.

Deletion is deferred. Foreign keys use `ON DELETE RESTRICT`; audit and outbox retention will be implemented as explicit archival policies rather than cascades. Rollback strategy is forward-only: repair bad schema with a new reviewed migration rather than editing an applied migration.
