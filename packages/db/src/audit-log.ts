import type {
  AuditLogEntryView,
  AuditLogRepository,
  UsageSummaryByOrg,
  UsageSummaryRepository,
  UsageSummaryView,
} from "@sculpin/domain";
import type { Pool } from "pg";

/**
 * §11 — read-only Postgres repositories backing the minimum admin operational
 * views (recent audit log + aggregate usage summary).
 *
 * These are SIMPLE reads (a single pool query each), so no explicit
 * transaction / PoolClient is needed. Both source tables are guaranteed safe by
 * their writers (see the §10 audit writer and the S13 usage-event insert): an
 * audit summary carries only SAFE metadata, and a usage row carries only ids +
 * quota cost + timestamp. These repositories therefore never SELECT the raw
 * `upstream_agent_id` or any credential-shaped column, and no read is audited.
 */

const DEFAULT_AUDIT_LIMIT = 50;
const MAX_AUDIT_LIMIT = 200;
const DEFAULT_TOP_ORGS = 5;
const MAX_TOP_ORGS = 25;

/**
 * Clamp a caller-supplied limit to `[1, MAX_AUDIT_LIMIT]` (default when NaN /
 * non-finite), flooring fractions, so an admin surface can never request an
 * unbounded number of rows.
 */
export function clampAuditLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_AUDIT_LIMIT;
  return Math.min(Math.max(1, Math.floor(limit)), MAX_AUDIT_LIMIT);
}

function clampTopOrgs(count: number): number {
  if (!Number.isFinite(count)) return DEFAULT_TOP_ORGS;
  return Math.min(Math.max(1, Math.floor(count)), MAX_TOP_ORGS);
}

interface AuditLogRow {
  id: string;
  occurredAt: Date;
  action: string;
  targetType: string;
  targetId: string;
  actorUserId: string | null;
  actorEmail: string | null;
  actorDisplayName: string | null;
  systemActor: string | null;
  organizationId: string | null;
  organizationSlug: string | null;
  beforeSummary: unknown;
  afterSummary: unknown;
}

export class PostgresAuditLogRepository implements AuditLogRepository {
  constructor(private readonly pool: Pool) {}

  async listRecent(limit: number): Promise<readonly AuditLogEntryView[]> {
    // Clamp server-side: the caller cannot request unbounded rows regardless of
    // what the UI passes. ORDER BY occurred_at DESC uses
    // idx_audit_events_occurred_at.
    const bounded = clampAuditLimit(limit);
    const result = await this.pool.query<AuditLogRow>(
      `SELECT ae.id,
              ae.occurred_at      AS "occurredAt",
              ae.action,
              ae.target_type      AS "targetType",
              ae.target_id        AS "targetId",
              ae.actor_user_id    AS "actorUserId",
              u.normalized_email  AS "actorEmail",
              u.display_name      AS "actorDisplayName",
              ae.system_actor     AS "systemActor",
              ae.organization_id  AS "organizationId",
              o.slug              AS "organizationSlug",
              ae.before_summary   AS "beforeSummary",
              ae.after_summary    AS "afterSummary"
         FROM audit_events ae
         LEFT JOIN users u ON u.id = ae.actor_user_id
         LEFT JOIN organizations o ON o.id = ae.organization_id
         ORDER BY ae.occurred_at DESC
         LIMIT $1`,
      [bounded],
    );
    return result.rows.map((row) => ({
      id: row.id,
      occurredAt: row.occurredAt.toISOString(),
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      actorUserId: row.actorUserId,
      actorEmail: row.actorEmail,
      actorDisplayName: row.actorDisplayName,
      systemActor: row.systemActor,
      organizationId: row.organizationId,
      organizationSlug: row.organizationSlug,
      beforeSummary: row.beforeSummary ?? null,
      afterSummary: row.afterSummary ?? null,
    }));
  }
}

interface UsageTotalRow {
  requestCount: string | number | null;
  totalQuotaCost: string | number | null;
}

interface UsageByOrgRow {
  organizationId: string;
  organizationSlug: string | null;
  requestCount: string | number | null;
  totalQuotaCost: string | number | null;
}

/** Coerce a pg bigint (returned as a string) / numeric to a JS number. */
function toNumber(value: string | number | null): number {
  if (value === null) return 0;
  return typeof value === "number" ? value : Number.parseInt(value, 10);
}

export class PostgresUsageSummaryRepository implements UsageSummaryRepository {
  constructor(private readonly pool: Pool) {}

  async summarize(topOrganizations?: number): Promise<UsageSummaryView> {
    const topN = clampTopOrgs(topOrganizations ?? DEFAULT_TOP_ORGS);
    // usage_events carries NO prompt/body/secret — only ids + quota_cost +
    // occurred_at. Aggregate totals over the whole table plus a bounded top-N
    // per-organization breakdown joined to organizations for the slug.
    const totalResult = await this.pool.query<UsageTotalRow>(
      `SELECT count(*)              AS "requestCount",
              coalesce(sum(quota_cost), 0) AS "totalQuotaCost"
         FROM usage_events`,
    );
    const total = totalResult.rows[0];
    const byOrgResult = await this.pool.query<UsageByOrgRow>(
      `SELECT ue.organization_id AS "organizationId",
              o.slug            AS "organizationSlug",
              count(*)          AS "requestCount",
              coalesce(sum(ue.quota_cost), 0) AS "totalQuotaCost"
         FROM usage_events ue
         LEFT JOIN organizations o ON o.id = ue.organization_id
         GROUP BY ue.organization_id, o.slug
         ORDER BY count(*) DESC, ue.organization_id
         LIMIT $1`,
      [topN],
    );
    const topOrgs: UsageSummaryByOrg[] = byOrgResult.rows.map((row) => ({
      organizationId: row.organizationId,
      organizationSlug: row.organizationSlug,
      requestCount: toNumber(row.requestCount),
      totalQuotaCost: toNumber(row.totalQuotaCost),
    }));
    return {
      totalRequestCount: toNumber(total?.requestCount ?? 0),
      totalQuotaCost: toNumber(total?.totalQuotaCost ?? 0),
      topOrganizations: topOrgs,
    };
  }
}
