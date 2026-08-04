import type {
  CreatePersonalTenantCommand,
  PersonalTenantResult,
  PersonalTenantTransaction,
  TenantContext,
} from "@sculpin/domain";
import type { Pool } from "pg";

export class PostgresPersonalTenantTransaction implements PersonalTenantTransaction {
  constructor(private readonly pool: Pool) {}
  async create(
    command: CreatePersonalTenantCommand,
  ): Promise<PersonalTenantResult> {
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
          "INSERT INTO external_identities (user_id, provider, provider_subject, provider_email, email_verified, claims) VALUES ($1,$2,$3,$4,$5,$6)",
          [
            userId,
            command.identity.provider,
            command.identity.providerSubject,
            command.identity.providerEmail ?? null,
            command.identity.emailVerified,
            command.identity.claims ?? {},
          ],
        );
      const organization = await client.query<{ id: string }>(
        "INSERT INTO organizations (slug, type) VALUES ($1, 'personal') RETURNING id",
        [command.organizationSlug],
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
      await client.query(
        "INSERT INTO outbox_events (organization_id, aggregate_type, aggregate_id, event_type, schema_version, payload, occurred_at, available_at) VALUES ($1,'organization',$1,'personal_organization.created',1,$2,now(),now())",
        [organizationId, { organizationId, userId }],
      );
      await client.query("COMMIT");
      return { userId, organizationId };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
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
