---
description: Single-migration-authority rules for the Prisma schema, migrations, generated client, and tenant/outbox invariants.
globs:
  - "packages/db/**"
  - "packages/domain/**"
---

# Database, migrations & domain invariants

Applies to: `packages/db/**` and `packages/domain/**`.

`packages/db` is the SINGLE migration authority. All schema change flows through here.

## Migration authority & generated output
- Author schema changes in `packages/db/prisma/schema.prisma`; create migrations under `packages/db/prisma/migrations/**`.
- NEVER hand-edit generated Prisma client output at `packages/db/generated/**`. Regenerate via `prisma generate`.
- Run `pnpm prisma:validate`, `pnpm prisma:format`, and `pnpm db:migration:test` before declaring a migration done. Migrations must apply cleanly forward on a FRESH database.

## Leak-resistant schema (CLAUDE.md rules 2, 5)
- A DB leak must not yield usable credentials. Store PATs ONLY as an HMAC-SHA-256 keyed digest; the key `PAT_HASH_SECRET` lives OUTSIDE the DB.
- Never add columns that persist raw PATs, the upstream key, OAuth secrets, prompts, or model responses.
- Usage/audit tables carry NO raw PAT, OAuth token, upstream key, complete body, prompt, or generated response.

## Atomicity invariants (D-011, D-012, rule 6)
- Personal-tenant provisioning stays atomic in ONE COMMIT: `User + ExternalIdentity + Organization + OrganizationMembership + AuditEvent + OutboxEvent`. Preserve the transactional outbox and its trigger scoping (`personal_organization.created`).
- Trial quota reservation MUST be atomic — no read-compare-increment. Design columns/constraints (e.g. a conditional decrement / single UPDATE with a guard) so the last unit cannot be double-granted under concurrency; back it with a concurrent last-quota test.
- `users.normalized_email` is intentionally NON-unique (isolated per-provider accounts, D-012). Do not add a unique constraint that would enable silent linking.
- Platform role enum `{user, admin}` is distinct from `MembershipRole {owner, member}`; keep `normalizedEmail`/`displayName` canonical and do not duplicate Better-Auth-owned fields on `users`.

## Tests before done
- `pnpm prisma:validate && pnpm prisma:generate`, `pnpm db:migration:test`, and the schema integration suite (`pnpm test:integration`, needs Compose Postgres). On engine mismatch, invoke tsc/eslint directly per CLAUDE.md.
