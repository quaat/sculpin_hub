import {
  validateQuotaAmount,
  type OrganizationId,
  type QuotaReservation,
  type Subscription,
  type SubscriptionPlan,
  type SubscriptionRepository,
  type SubscriptionStatus,
} from "@sculpin/domain";
import type { Pool } from "pg";

interface SubscriptionRow {
  id: string;
  organizationId: string;
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  quotaLimit: number;
  quotaUsed: number;
  startsAt: Date;
  endsAt: Date | null;
  version: number;
}

const SELECT_COLUMNS =
  'id, organization_id AS "organizationId", plan, status, quota_limit AS "quotaLimit", quota_used AS "quotaUsed", starts_at AS "startsAt", ends_at AS "endsAt", version';

function mapRow(row: SubscriptionRow): Subscription {
  return {
    id: row.id,
    organizationId: row.organizationId,
    plan: row.plan,
    status: row.status,
    quotaLimit: Number(row.quotaLimit),
    quotaUsed: Number(row.quotaUsed),
    startsAt: row.startsAt,
    ...(row.endsAt !== null ? { endsAt: row.endsAt } : {}),
    version: row.version,
  };
}

export class PostgresSubscriptionRepository implements SubscriptionRepository {
  constructor(private readonly pool: Pool) {}

  async listForOrganization(
    organizationId: OrganizationId,
  ): Promise<readonly Subscription[]> {
    const result = await this.pool.query<SubscriptionRow>(
      `SELECT ${SELECT_COLUMNS} FROM subscriptions WHERE organization_id=$1 ORDER BY starts_at, id`,
      [organizationId],
    );
    return result.rows.map(mapRow);
  }

  async reserveQuota(
    organizationId: OrganizationId,
    amount: number,
  ): Promise<QuotaReservation> {
    validateQuotaAmount(amount);
    // Atomic reservation: a single UPDATE whose target row is selected (and
    // row-locked) by a subquery that only matches an active, in-window
    // subscription with enough remaining budget. `FOR UPDATE` (no SKIP LOCKED)
    // serializes concurrent reservations on the same subscription so a
    // last-quota race yields exactly one winner — the loser re-evaluates the
    // `quota_used + $2 <= quota_limit` predicate against committed data and finds
    // no row, so 0 rows are updated (denied). No read-compare-write anywhere.
    const reserved = await this.pool.query<{ remaining: number }>(
      `UPDATE subscriptions
       SET quota_used = quota_used + $2, version = version + 1, updated_at = now()
       WHERE id = (
         SELECT id FROM subscriptions
         WHERE organization_id = $1
           AND status = 'active'
           AND (ends_at IS NULL OR ends_at > now())
           AND quota_used + $2 <= quota_limit
         ORDER BY ends_at NULLS LAST, id
         FOR UPDATE
         LIMIT 1
       )
       RETURNING quota_limit - quota_used AS remaining`,
      [organizationId, amount],
    );
    const row = reserved.rows[0];
    if (row)
      return { granted: true, remainingQuota: Number(row.remaining) };
    const pooled = await this.pool.query<{ remaining: string | null }>(
      `SELECT COALESCE(SUM(quota_limit - quota_used), 0) AS remaining
       FROM subscriptions
       WHERE organization_id = $1
         AND status = 'active'
         AND (ends_at IS NULL OR ends_at > now())`,
      [organizationId],
    );
    return {
      granted: false,
      remainingQuota: Number(pooled.rows[0]?.remaining ?? 0),
    };
  }

  async setStatus(
    id: string,
    status: SubscriptionStatus,
  ): Promise<Subscription | undefined> {
    // Enforces the state machine in SQL: only an `active` subscription can move
    // to a terminal state. A no-op (already terminal / not found / illegal
    // target) updates 0 rows and returns undefined.
    const result = await this.pool.query<SubscriptionRow>(
      `UPDATE subscriptions
       SET status = $2::subscription_status,
           ends_at = CASE WHEN ends_at IS NULL THEN now() ELSE ends_at END,
           version = version + 1,
           updated_at = now()
       WHERE id = $1 AND status = 'active' AND $2 IN ('canceled', 'expired')
       RETURNING ${SELECT_COLUMNS}`,
      [id, status],
    );
    const row = result.rows[0];
    return row ? mapRow(row) : undefined;
  }
}
