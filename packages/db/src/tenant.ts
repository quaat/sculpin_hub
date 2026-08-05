import {
  DomainConflictError,
  validateCreatePersonalTenantCommand,
  type CreatePersonalTenantCommand,
  type IdentityRepository,
  type PersonalTenantResult,
  type PersonalTenantTransaction,
  type TenantContext,
} from "@sculpin/domain";
import type { Pool } from "pg";
import { validateOutboxPayload } from "./outbox.js";

function mapPostgresConflict(error: unknown): never {
  const pgError = error as { code?: string; constraint?: string };
  if (
    pgError.code === "23505" &&
    pgError.constraint === "external_identities_provider_provider_subject_key"
  )
    throw new DomainConflictError("identity_conflict");
  if (
    pgError.code === "23505" &&
    pgError.constraint === "organizations_slug_key"
  )
    throw new DomainConflictError("organization_slug_conflict");
  throw error;
}

export class PostgresPersonalTenantTransaction
  implements PersonalTenantTransaction
{
  constructor(private readonly pool: Pool) {}
  async create(
    command: CreatePersonalTenantCommand,
  ): Promise<PersonalTenantResult> {
    validateCreatePersonalTenantCommand(command);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const user = await client.query<{ id: string }>(
        "INSERT INTO users (normalized_email, display_name, locale) VALUES ($1,$2,$3) RETURNING id",
        [command.normalizedEmail, command.displayName, command.locale],
      );
      const userId = user.rows[0]?.id;
      if (!userId) throw new Error("user_insert_failed");
      if (command.identity)
        await client.query(
          "INSERT INTO external_identities (user_id, provider, provider_subject, provider_email, email_verified, safe_metadata) VALUES ($1,$2,$3,$4,$5,$6)",
          [
            userId,
            command.identity.provider,
            command.identity.providerSubject,
            command.identity.providerEmail?.toLowerCase() ?? null,
            command.identity.emailVerified,
            command.identity.metadata ?? null,
          ],
        );
      const organization = await client.query<{ id: string }>(
        "INSERT INTO organizations (slug, type, personal_owner_user_id) VALUES ($1, 'personal', $2) RETURNING id",
        [command.organizationSlug, userId],
      );
      const organizationId = organization.rows[0]?.id;
      if (!organizationId) throw new Error("organization_insert_failed");
      await client.query(
        "INSERT INTO organization_memberships (organization_id, user_id, role) VALUES ($1,$2,'owner')",
        [organizationId, userId],
      );
      await client.query(
        "INSERT INTO audit_events (organization_id, actor_user_id, action, target_type, target_id, after_summary, request_id, occurred_at) VALUES ($1,$2,'personal_organization.created','organization',$1,$3,$4,now())",
        [organizationId, userId, { type: "personal" }, command.requestId],
      );
      const payload = { organizationId, userId };
      validateOutboxPayload("personal_organization.created", 1, payload);
      await client.query(
        "INSERT INTO outbox_events (organization_id, aggregate_type, aggregate_id, event_type, schema_version, payload, occurred_at, available_at) VALUES ($1,'organization',$1,'personal_organization.created',1,$2,now(),now())",
        [organizationId, payload],
      );
      await client.query("COMMIT");
      return { userId, organizationId };
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "personal tenant transaction rollback failed",
        );
      }
      mapPostgresConflict(error);
    } finally {
      client.release();
    }
  }
}

export class PostgresMembershipRepository {
  constructor(private readonly pool: Pool) {}
  async list(
    context: TenantContext,
  ): Promise<readonly { userId: string; role: "owner" | "member" }[]> {
    const result = await this.pool.query<{
      userId: string;
      role: "owner" | "member";
    }>(
      "SELECT user_id AS \"userId\", role FROM organization_memberships WHERE organization_id=$1 AND status='active'",
      [context.organizationId],
    );
    return result.rows;
  }
  async findUser(
    context: TenantContext,
    userId: string,
  ): Promise<{ userId: string; role: "owner" | "member" } | undefined> {
    const result = await this.pool.query<{
      userId: string;
      role: "owner" | "member";
    }>(
      "SELECT user_id AS \"userId\", role FROM organization_memberships WHERE organization_id=$1 AND user_id=$2 AND status='active'",
      [context.organizationId, userId],
    );
    return result.rows[0];
  }
}

export class PostgresIdentityRepository implements IdentityRepository {
  constructor(private readonly pool: Pool) {}
  async findUserId(
    provider: string,
    providerSubject: string,
  ): Promise<string | undefined> {
    const result = await this.pool.query<{ userId: string }>(
      'SELECT user_id AS "userId" FROM external_identities WHERE provider=$1 AND provider_subject=$2',
      [provider, providerSubject],
    );
    return result.rows[0]?.userId;
  }
}
