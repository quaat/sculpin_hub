# ADR 008: Admin-configurable plan domain and explicit subscription claim

## Status

Accepted. Supersedes the trial-on-provisioning slice of [D-015](../DECISIONS.md); the union-entitlement and atomic-quota mechanics of D-015 remain in force.

## Context

M4 shipped a thin subscription slice: every personal tenant was auto-granted a `trial` subscription inside the provisioning transaction, and `subscriptions.plan` was a two-value enum (`trial`/`commercial`). Entitlement was the union of a tenant's active subscriptions, gated on an active, in-quota state. That slice conflated three concerns that must be separable before admin surfaces (Stage G) and per-agent authorization (later data-plane milestones) can land:

1. **Products** — what plans exist, what they grant, who may claim them — is an admin concern, not a hard-coded pair of enum values.
2. **Entitlement → specific Sculpin agents** — a plan grants access to a curated SET of catalogue entries (agents), which the data plane must later intersect with the published catalogue and PAT scopes.
3. **The claim journey** — obtaining access is an explicit, auditable act, not an implicit side effect of signing in.

Auto-granting a trial also meant a valid credential effectively always carried entitlement, which is the opposite of the intended fail-closed posture once plans become finite/one-time.

## Decision

Introduce an admin-configurable **`Plan`** domain and an **explicit subscription claim** journey, with per-subscription **snapshots** so plan edits never rewrite history.

### Plan model (`plans`)

A plan is an admin-owned product: `key` (unique lower-case slug), `name`, `description?`, `kind` (`free_trial` | `commercial_monthly` | `commercial_annual`), `enabled`, `published`, `self_service_eligible`, `admin_grantable`, `duration_days?` (`NULL` = open-ended), `request_quota` (>= 0), `one_time_per_organization`, `created_by`/`updated_by`, `version`. Column CHECKs mirror the pure `validatePlanInput` domain guard (defense in depth).

### Authoritative entitlement mapping (`plan_catalogue_entries`)

A plan's granted agents are the M2M `plan_catalogue_entries` (`plan_id`, `catalogue_entry_id`; `catalogue_entry_id` is `ON DELETE RESTRICT` so a referenced agent cannot be deleted out from under a plan). This admin-configured set is the AUTHORITATIVE definition of what a plan entitles.

### Snapshot semantics

Claiming a plan (`SubscriptionRepository.grantFromPlan`) materializes a subscription in ONE transaction and **snapshots** two things from the plan at grant time:

- `subscriptions.plan_kind` — the plan's `kind` denormalized onto the subscription;
- `subscription_catalogue_entries` — a COPY of the plan's current `plan_catalogue_entries` rows.

These snapshots NEVER change afterward. Editing a plan's mapping later (attach/detach) does not retroactively alter any existing subscription's offerings — an existing subscriber keeps exactly what they were granted. The subscription is the frozen unit of entitlement; the plan is the mutable template.

### Explicit claim journey (no auto-trial)

Provisioning no longer grants any subscription. Both atomic paths — the pg `PostgresPersonalTenantTransaction` and the Better-Auth Prisma `provisionPersonalTenant` — still commit `User + ExternalIdentity + Organization + OrganizationMembership + AuditEvent + OutboxEvent` in one COMMIT (D-011) with the outbox trigger scoped to `personal_organization.created`, but write NO `subscriptions` row. A freshly provisioned tenant therefore has NO entitlement until it explicitly claims a plan. A seeded `free-trial` plan (fixed uuid, `request_quota = 200`, `one_time_per_organization = true`, published + self-service) exists so the future claim UI has a default target; its catalogue offerings are attached by admins later.

### One-time invariant (`plan_claims`)

When a plan is `one_time_per_organization`, `grantFromPlan` inserts a `plan_claims (organization_id, plan_id)` row in the SAME transaction as the subscription. The composite PRIMARY KEY makes a second claim raise SQLSTATE `23505`, mapped to `DomainConflictError("plan_already_claimed")` after `ROLLBACK`. Non-one-time plans write no claim row and may be subscribed repeatedly.

### Suspended state

`subscription_status` gains `suspended`. The state machine is now `active → {suspended, canceled, expired}`, `suspended → {active, canceled, expired}`, and `canceled`/`expired` terminal. `suspended` is NOT active/entitling: `isSubscriptionActive` returns true only for `active` in-window subscriptions, so a suspended subscription grants neither quota nor agents until resumed. Terminal transitions stamp `ends_at` when unset; suspend/resume leave the window untouched. Both the domain transition table and the SQL `setStatus` (which only updates rows whose current status is a legal predecessor) enforce this.

### Entitlement is the composable seam

`resolveEntitlement` (pure, unit-tested) returns `{ active, planKeys, remainingQuota, entitledCatalogueEntryIds }`, where `entitledCatalogueEntryIds` is the sorted, de-duplicated union of the active subscriptions' SNAPSHOT offerings. This is deliberately the seam a later milestone intersects with the published catalogue + PAT scopes to decide which specific agents a caller may reach. Quota reservation is unchanged from D-015: a single conditional `UPDATE` (no read-compare-write), proven under a concurrent last-quota stampede.

## Consequences

- A valid session/PAT alone never carries entitlement; access requires an explicit claim, which is the intended fail-closed posture.
- Plan edits are safe: they shape future grants only, so support/audit can reason about a subscriber's entitlement from the frozen snapshot.
- The migration swaps the `subscription_status` enum via rename + recreate + cast (Postgres cannot `ADD VALUE` and use it in the same transaction), drops the old `plan` column and `subscription_plan` type, and backfills dev-only rows onto the seeded free-trial plan before making `plan_id`/`plan_kind` NOT NULL. There is no production data.
- Deferred: the claim/admin UI (Stage G), the data-plane intersection of `entitledCatalogueEntryIds` with the catalogue + PAT scopes, subscription outbox events, and any payment provider (still none — D-004).
- Rollback remains forward-only: repair with a new reviewed migration, never edit an applied one.
