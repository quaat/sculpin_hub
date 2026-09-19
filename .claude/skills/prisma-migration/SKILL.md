---
name: prisma-migration
description: Use when changing the Prisma schema or authoring a migration — enforces single migration authority, leak-resistant columns, atomicity invariants, and the validate/generate/test loop.
---

# prisma-migration

Safely evolve the database. `packages/db` is the single migration authority.

## When to use
Any change to `packages/db/prisma/schema.prisma`, a new migration, or tenant/outbox/quota persistence.

## Steps
1. Edit `packages/db/prisma/schema.prisma`. Keep `users.normalized_email` NON-unique (isolated per-provider accounts, D-012). Platform role `{user, admin}` stays distinct from `MembershipRole`.
2. Do NOT persist raw PATs, upstream keys, OAuth secrets, prompts, or responses. PATs are stored only as an HMAC-SHA-256 keyed digest (`PAT_HASH_SECRET` outside the DB).
3. Preserve atomic personal-tenant provisioning (one COMMIT: user + external identity + org + membership + audit + outbox) and the outbox trigger scoping (`personal_organization.created`).
4. Design trial-quota columns for an ATOMIC single-statement decrement (no read-compare-increment).
5. Never hand-edit `packages/db/generated/**` — regenerate.
6. Run the loop:
   - `pnpm prisma:validate`
   - `pnpm prisma:format`
   - `pnpm prisma:generate`
   - `pnpm db:migration:test`
   - `pnpm test:integration` (needs `docker compose up -d postgres redis`)
   On engine mismatch (`ERR_PNPM_UNSUPPORTED_ENGINE`), invoke tsc directly per CLAUDE.md.
7. Confirm the migration applies forward cleanly on a FRESH DB and existing invariants hold (no user without a personal org).

## Never
Run `reset --hard` or manual DB drops outside the integration harness teardown.
