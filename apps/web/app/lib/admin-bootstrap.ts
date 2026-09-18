import type { Prisma } from "../../../../packages/db/generated/prisma/index.js";

/**
 * Admin bootstrap (M2 identity slice, D-010 / CLAUDE.md rule 8).
 *
 * Grants the platform `admin` role to a user ONLY when a VERIFIED provider
 * email matches the operator-managed `BOOTSTRAP_ADMIN_EMAILS` allowlist. Never
 * trusts an unverified email. The elevation is idempotent (a no-op if the user
 * is already admin) and writes an append-only `audit_events` row attributed to
 * the `admin-bootstrap` system actor.
 *
 * MUST run inside the sign-up transaction, AFTER the personal org exists (it is
 * invoked from `account.create.before` in auth.ts, right after
 * `provisionPersonalTenant`). It performs the role UPDATE and then looks up the
 * personal org for the audit row; if that lookup misses it throws so the whole
 * transaction rolls back. Running this post-commit is therefore UNSAFE — a
 * successful UPDATE followed by a missing-org throw would leave an elevated user
 * with no rollback and no audit row.
 */
export interface AdminBootstrapInput {
  readonly userId: string;
  /** The email asserted by the provider for this sign-in. */
  readonly providerEmail: string | null | undefined;
  /** Whether the provider VERIFIED that email. Unverified => never elevated. */
  readonly emailVerified: boolean;
  /** Normalized, lowercased allowlist from validated config. */
  readonly allowlist: readonly string[];
  /** Correlates the audit row with the originating request. */
  readonly requestId: string;
}

export type AdminBootstrapClient = Pick<
  Prisma.TransactionClient,
  "$queryRaw" | "$executeRaw"
>;

/**
 * Returns `true` iff the verified email is present in the allowlist. Pure and
 * side-effect free so it can be unit tested without a database.
 */
export function isAllowlistedAdmin(input: {
  providerEmail: string | null | undefined;
  emailVerified: boolean;
  allowlist: readonly string[];
}): boolean {
  if (!input.emailVerified) return false;
  const email = input.providerEmail?.trim().toLowerCase();
  if (!email) return false;
  return input.allowlist.includes(email);
}

/**
 * Idempotently elevate the user to `admin` when allowlisted, recording an audit
 * event scoped to the user's personal organization. No-ops (returns `false`)
 * when the email is unverified/absent, not allowlisted, or the user is already
 * admin. Any DB error is intentionally allowed to propagate to the caller.
 */
export async function reconcileAdminBootstrap(
  db: AdminBootstrapClient,
  input: AdminBootstrapInput,
): Promise<boolean> {
  if (
    !isAllowlistedAdmin({
      providerEmail: input.providerEmail,
      emailVerified: input.emailVerified,
      allowlist: input.allowlist,
    })
  ) {
    return false;
  }

  // Only elevate a currently-`user` row; the RETURNING clause makes the
  // operation idempotent (no rows => already admin or missing => no audit).
  const elevated = await db.$queryRaw<{ id: string }[]>`
    UPDATE users
    SET role = 'admin', updated_at = now()
    WHERE id = ${input.userId}::uuid AND role = 'user'
    RETURNING id
  `;
  if (elevated.length === 0) return false;

  // Scope the audit to the user's personal organization (owner membership
  // guarantees the org exists). Attributed to the system actor, not the user.
  const orgRows = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM organizations
    WHERE type = 'personal' AND personal_owner_user_id = ${input.userId}::uuid
    LIMIT 1
  `;
  const organizationId = orgRows[0]?.id;
  if (!organizationId) {
    // No personal org yet (provisioning not wired): the role change stands but
    // we cannot attach an org-scoped audit row. Surface this to the caller.
    throw new Error("admin_bootstrap_missing_personal_org");
  }

  const summary = JSON.stringify({ role: "admin", via: "bootstrap_allowlist" });
  await db.$executeRaw`
    INSERT INTO audit_events
      (organization_id, system_actor, action, target_type, target_id, after_summary, request_id, occurred_at)
    VALUES
      (${organizationId}::uuid, 'admin-bootstrap', 'user.role.granted', 'user',
       ${input.userId}::uuid, ${summary}::jsonb, ${input.requestId}, now())
  `;
  return true;
}
