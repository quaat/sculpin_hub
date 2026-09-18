import { validateOutboxPayload } from "@sculpin/db";
import type { Prisma } from "../../../../packages/db/generated/prisma/index.js";

/**
 * Prisma interactive-transaction client. Better Auth opens the transaction for
 * OAuth sign-up (user + account creation); we run the personal-tenant
 * provisioning against that SAME client so everything commits atomically.
 */
export type ProvisioningTx = Prisma.TransactionClient;

export interface ProvisionPersonalTenantInput {
  /** The `users.id` Better Auth created earlier in the same transaction. */
  readonly userId: string;
  /** DNS-label slug for the personal organization (see `personalOrganizationSlug`). */
  readonly organizationSlug: string;
  /** Correlates the audit + outbox rows with the originating sign-up request. */
  readonly requestId: string;
}

export interface ProvisionedPersonalTenant {
  readonly userId: string;
  readonly organizationId: string;
  /** `false` when a personal org already existed (idempotent no-op). */
  readonly created: boolean;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const slugPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const requestIdPattern = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Derive a DNS-label organization slug for a new personal tenant. The value is
 * only used to satisfy the slug constraint; a random suffix avoids collisions
 * with concurrent sign-ups.
 */
export function personalOrganizationSlug(): string {
  const suffix = globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 20);
  return `p-${suffix}`;
}

function validateInput(input: ProvisionPersonalTenantInput): void {
  if (!uuidPattern.test(input.userId))
    throw new Error("provisioning_invalid_user_id");
  if (!slugPattern.test(input.organizationSlug))
    throw new Error("provisioning_invalid_slug");
  if (!requestIdPattern.test(input.requestId))
    throw new Error("provisioning_invalid_request_id");
}

/**
 * Atomically create a personal organization + owner membership + audit event +
 * outbox event for a user that Better Auth already inserted earlier in the SAME
 * transaction. Better Auth owns the `users` row and (via the account create) the
 * `external_identities` row; this fills in the tenant context so a new user is
 * never left without a personal org. Idempotent: if a personal org already
 * exists for the user (e.g. the account-create hook fires more than once), it
 * returns the existing org without writing.
 */
export async function provisionPersonalTenant(
  tx: ProvisioningTx,
  input: ProvisionPersonalTenantInput,
): Promise<ProvisionedPersonalTenant> {
  validateInput(input);
  const { userId, organizationSlug, requestId } = input;

  const existing = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM organizations
    WHERE type = 'personal' AND personal_owner_user_id = ${userId}::uuid
    LIMIT 1
  `;
  const existingOrgId = existing[0]?.id;
  if (existingOrgId)
    return { userId, organizationId: existingOrgId, created: false };

  // ON CONFLICT DO NOTHING guards against a concurrent sign-up racing on the
  // same user: the loser gets no row back instead of a unique-violation that
  // would abort the whole transaction. `organizations_personal_owner_user_id_key`
  // enforces one personal org per user.
  const orgRows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO organizations (slug, type, personal_owner_user_id)
    VALUES (${organizationSlug}, 'personal', ${userId}::uuid)
    ON CONFLICT (personal_owner_user_id) DO NOTHING
    RETURNING id
  `;
  const organizationId = orgRows[0]?.id;
  if (!organizationId) {
    // Lost the race: the winning transaction already created (and populated)
    // the personal org. Re-read it and skip our own side-effect inserts. If it
    // is still absent, fail closed rather than leave a half-provisioned tenant.
    const raced = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM organizations
      WHERE type = 'personal' AND personal_owner_user_id = ${userId}::uuid
      LIMIT 1
    `;
    const racedOrgId = raced[0]?.id;
    if (!racedOrgId) throw new Error("organization_insert_failed");
    return { userId, organizationId: racedOrgId, created: false };
  }

  await tx.$executeRaw`
    INSERT INTO organization_memberships (organization_id, user_id, role)
    VALUES (${organizationId}::uuid, ${userId}::uuid, 'owner')
  `;

  await tx.$executeRaw`
    INSERT INTO audit_events
      (organization_id, actor_user_id, action, target_type, target_id, after_summary, request_id, occurred_at)
    VALUES
      (${organizationId}::uuid, ${userId}::uuid, 'personal_organization.created', 'organization',
       ${organizationId}::uuid, ${JSON.stringify({ type: "personal" })}::jsonb, ${requestId}, now())
  `;

  const payload = { organizationId, userId };
  validateOutboxPayload("personal_organization.created", 1, payload);
  await tx.$executeRaw`
    INSERT INTO outbox_events
      (organization_id, aggregate_type, aggregate_id, event_type, schema_version, payload, occurred_at, available_at)
    VALUES
      (${organizationId}::uuid, 'organization', ${organizationId}::uuid, 'personal_organization.created', 1,
       ${JSON.stringify(payload)}::jsonb, now(), now())
  `;

  return { userId, organizationId, created: true };
}
