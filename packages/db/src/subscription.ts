import {
  DomainConflictError,
  DomainValidationError,
  assertSubscriptionTransition,
  validateQuotaAmount,
  type OrganizationId,
  type PlanKind,
  type QuotaReservation,
  type Subscription,
  type SubscriptionRepository,
  type SubscriptionStatus,
  type UsageContext,
} from "@sculpin/domain";
import type { Pool, PoolClient } from "pg";
import { insertAuditEvent } from "./audit.js";

interface SubscriptionRow {
  id: string;
  organizationId: string;
  planId: string;
  planKey: string;
  planKind: PlanKind;
  status: SubscriptionStatus;
  quotaLimit: number;
  quotaUsed: number;
  startsAt: Date;
  endsAt: Date | null;
  offerings: string[] | null;
  version: number;
}

// Joins `plans` for the stable plan key and aggregates the per-subscription
// SNAPSHOT offerings (subscription_catalogue_entries). `offerings` is the frozen
// catalogue-entry set copied at grant time — never the plan's current mapping.
const SELECT_COLUMNS = `s.id,
  s.organization_id AS "organizationId",
  s.plan_id AS "planId",
  p.key AS "planKey",
  s.plan_kind AS "planKind",
  s.status,
  s.quota_limit AS "quotaLimit",
  s.quota_used AS "quotaUsed",
  s.starts_at AS "startsAt",
  s.ends_at AS "endsAt",
  COALESCE(
    (SELECT array_agg(sce.catalogue_entry_id::text ORDER BY sce.catalogue_entry_id)
       FROM subscription_catalogue_entries sce
      WHERE sce.subscription_id = s.id),
    ARRAY[]::text[]
  ) AS offerings,
  s.version`;

const FROM_JOIN = "FROM subscriptions s JOIN plans p ON p.id = s.plan_id";

function mapRow(row: SubscriptionRow): Subscription {
  return {
    id: row.id,
    organizationId: row.organizationId,
    planId: row.planId,
    planKey: row.planKey,
    planKind: row.planKind,
    status: row.status,
    quotaLimit: Number(row.quotaLimit),
    quotaUsed: Number(row.quotaUsed),
    startsAt: row.startsAt,
    ...(row.endsAt !== null ? { endsAt: row.endsAt } : {}),
    offerings: row.offerings ?? [],
    version: row.version,
  };
}

interface PlanRowForGrant {
  id: string;
  kind: PlanKind;
  requestQuota: number;
  durationDays: number | null;
  oneTimePerOrganization: boolean;
}

export class PostgresSubscriptionRepository implements SubscriptionRepository {
  constructor(private readonly pool: Pool) {}

  async listForOrganization(
    organizationId: OrganizationId,
  ): Promise<readonly Subscription[]> {
    const result = await this.pool.query<SubscriptionRow>(
      `SELECT ${SELECT_COLUMNS} ${FROM_JOIN} WHERE s.organization_id=$1 ORDER BY s.starts_at, s.id`,
      [organizationId],
    );
    return result.rows.map(mapRow);
  }

  async grantFromPlan(
    organizationId: OrganizationId,
    planId: string,
    grant: {
      readonly actorUserId: string;
      readonly requestId: string;
      readonly viaAdmin: boolean;
    },
  ): Promise<Subscription> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Row-lock the plan (FOR SHARE) so a concurrent setEnabled cannot flip the
      // enabled flag between this eligibility check and the grant. It does NOT
      // cover attach/detach (those touch plan_catalogue_entries, not this row);
      // the snapshot copy below is a single INSERT ... SELECT, so under READ
      // COMMITTED it captures a whole committed version of the catalogue set
      // (never a torn half-set) regardless of concurrent admin edits.
      const plan = await client.query<PlanRowForGrant & { enabled: boolean }>(
        `SELECT id, kind, enabled, request_quota AS "requestQuota", duration_days AS "durationDays",
                one_time_per_organization AS "oneTimePerOrganization"
         FROM plans WHERE id = $1 FOR SHARE`,
        [planId],
      );
      const planRow = plan.rows[0];
      if (!planRow) {
        await client.query("ROLLBACK");
        throw new DomainValidationError("Plan does not exist.");
      }
      if (planRow.enabled !== true) {
        await client.query("ROLLBACK");
        throw new DomainValidationError("Plan is disabled.");
      }
      // one-time claim ledger: a duplicate (org, plan) raises 23505 → conflict.
      if (planRow.oneTimePerOrganization) {
        try {
          await client.query(
            "INSERT INTO plan_claims (organization_id, plan_id) VALUES ($1,$2)",
            [organizationId, planId],
          );
        } catch (error) {
          await client.query("ROLLBACK");
          if ((error as { code?: string }).code === "23505")
            throw new DomainConflictError("plan_already_claimed");
          throw error;
        }
      }
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO subscriptions (organization_id, plan_id, plan_kind, status, quota_limit, ends_at)
         VALUES (
           $1, $2, $3::plan_kind, 'active', $4,
           CASE WHEN $5::integer IS NULL THEN NULL ELSE now() + ($5::integer || ' days')::interval END
         )
         RETURNING id`,
        [
          organizationId,
          planId,
          planRow.kind,
          planRow.requestQuota,
          planRow.durationDays,
        ],
      );
      const subscriptionId = inserted.rows[0]?.id;
      if (!subscriptionId) {
        await client.query("ROLLBACK");
        throw new Error("subscription_insert_failed");
      }
      // SNAPSHOT copy: freeze the plan's CURRENT catalogue-entry set onto the
      // subscription. Later plan edits never change these rows.
      await client.query(
        `INSERT INTO subscription_catalogue_entries (subscription_id, catalogue_entry_id)
         SELECT $1, catalogue_entry_id FROM plan_catalogue_entries WHERE plan_id = $2`,
        [subscriptionId, planId],
      );
      const row = await client.query<SubscriptionRow>(
        `SELECT ${SELECT_COLUMNS} ${FROM_JOIN} WHERE s.id = $1`,
        [subscriptionId],
      );
      const mapped = row.rows[0];
      if (!mapped) {
        await client.query("ROLLBACK");
        throw new Error("subscription_read_failed");
      }
      const subscription = mapRow(mapped);
      // Audit the grant in the SAME transaction. Self-service (viaAdmin=false):
      // the actor is the org's own owner-member, so the event is org-scoped and
      // the composite membership FK is satisfied. Admin grant (viaAdmin=true):
      // the admin is NOT a member of the grantee org, so the event is
      // PLATFORM-GLOBAL (organization_id = NULL) and names the affected org in
      // after_summary. Only safe metadata (ids, plan key, quota, status).
      if (grant.viaAdmin) {
        await insertAuditEvent(client, {
          organizationId: null,
          actor: { actorUserId: grant.actorUserId },
          action: "subscription.admin_granted",
          targetType: "subscription",
          targetId: subscription.id,
          afterSummary: {
            organizationId,
            planId,
            planKey: subscription.planKey,
            quotaLimit: subscription.quotaLimit,
            status: subscription.status,
          },
          requestId: grant.requestId,
        });
      } else {
        await insertAuditEvent(client, {
          organizationId,
          actor: { actorUserId: grant.actorUserId },
          action: "subscription.self_claimed",
          targetType: "subscription",
          targetId: subscription.id,
          afterSummary: {
            planId,
            planKey: subscription.planKey,
            quotaLimit: subscription.quotaLimit,
            status: subscription.status,
          },
          requestId: grant.requestId,
        });
      }
      await client.query("COMMIT");
      return subscription;
    } catch (error) {
      // If we already ROLLBACK'd above, this is a no-op; guard against a double
      // rollback surfacing as an error.
      try {
        await client.query("ROLLBACK");
      } catch {
        // ignore — the transaction was already resolved.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async reserveQuota(
    organizationId: OrganizationId,
    amount: number,
    usage: UsageContext,
  ): Promise<QuotaReservation> {
    validateQuotaAmount(amount);
    // Atomic, OFFERING-BOUND reservation + usage accounting (CLAUDE.md rule 6;
    // S13/M7 D-023). Both the conditional quota UPDATE and the granted request's
    // usage_events INSERT run in ONE explicit transaction so quota and usage
    // commit together or neither. The UPDATE's target row is selected (and
    // row-locked) by a subquery that only matches a subscription that: belongs to
    // the org, is active and in-window, has enough remaining budget, AND whose
    // FROZEN snapshot (`subscription_catalogue_entries`) actually grants the
    // requested offering (`usage.catalogueEntryId`, $3). Quota from a subscription
    // that does NOT grant the requested offering is therefore never usable, even
    // though the tenant may hold other active subscriptions. When SEVERAL active
    // subscriptions grant the SAME offering, this pools across them: the subquery
    // picks the first eligible one with room (soonest-expiring first), so the last
    // unit of the pool for that offering is spent before a denial. `FOR UPDATE`
    // (no SKIP LOCKED) serializes concurrent reservations on the SAME row so a
    // last-quota race yields exactly one winner; the loser re-evaluates
    // `quota_used + $2 <= quota_limit` against committed data, finds no eligible
    // row, and 0 rows are updated (denied). The lock is held until COMMIT so the
    // usage row is bound to the winning update. No read-compare-write anywhere. A
    // usage_events row is written ONLY on grant — never on a denial — and its
    // subscription_id therefore always identifies a subscription whose snapshot
    // contains the recorded catalogue_entry_id.
    const client: PoolClient = await this.pool.connect();
    let resolved = false;
    try {
      await client.query("BEGIN");
      const reserved = await client.query<{ id: string; remaining: number }>(
        `UPDATE subscriptions
         SET quota_used = quota_used + $2, version = version + 1, updated_at = now()
         WHERE id = (
           SELECT s.id FROM subscriptions s
           WHERE s.organization_id = $1
             AND s.status = 'active'
             AND (s.ends_at IS NULL OR s.ends_at > now())
             AND s.quota_used + $2 <= s.quota_limit
             AND EXISTS (
               SELECT 1 FROM subscription_catalogue_entries sce
               WHERE sce.subscription_id = s.id
                 AND sce.catalogue_entry_id = $3::uuid
             )
           ORDER BY s.ends_at NULLS LAST, s.id
           FOR UPDATE
           LIMIT 1
         )
         RETURNING id, quota_limit - quota_used AS remaining`,
        [organizationId, amount, usage.catalogueEntryId],
      );
      const row = reserved.rows[0];
      if (row) {
        // Granted: record the per-request usage event in the SAME transaction.
        // NO secret/prompt/body is stored; pat_id is the PAT row id.
        await client.query(
          `INSERT INTO usage_events
             (organization_id, subscription_id, catalogue_entry_id, pat_id, request_id, quota_cost)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            organizationId,
            row.id,
            usage.catalogueEntryId,
            usage.patId,
            usage.requestId,
            amount,
          ],
        );
        await client.query("COMMIT");
        resolved = true;
        return { granted: true, remainingQuota: Number(row.remaining) };
      }
      // Denied: no writes happened; close the transaction and report the
      // remaining quota AVAILABLE FOR THE REQUESTED OFFERING — i.e. pooled only
      // across active, in-window subscriptions whose snapshot grants
      // `usage.catalogueEntryId`. Quota held by unrelated subscriptions is NOT
      // counted, so a denial for offering A never reports offering B's budget. NO
      // usage event is recorded on a denial.
      await client.query("COMMIT");
      resolved = true;
      const pooled = await client.query<{ remaining: string | null }>(
        `SELECT COALESCE(SUM(s.quota_limit - s.quota_used), 0) AS remaining
         FROM subscriptions s
         WHERE s.organization_id = $1
           AND s.status = 'active'
           AND (s.ends_at IS NULL OR s.ends_at > now())
           AND EXISTS (
             SELECT 1 FROM subscription_catalogue_entries sce
             WHERE sce.subscription_id = s.id
               AND sce.catalogue_entry_id = $2::uuid
           )`,
        [organizationId, usage.catalogueEntryId],
      );
      return {
        granted: false,
        remainingQuota: Number(pooled.rows[0]?.remaining ?? 0),
      };
    } catch (error) {
      if (!resolved) {
        // Guard against a double rollback surfacing as an error (mirrors
        // grantFromPlan): only roll back if we have not already resolved the tx.
        try {
          await client.query("ROLLBACK");
        } catch {
          // ignore — the transaction was already resolved.
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async setStatus(
    id: string,
    status: SubscriptionStatus,
    actor: { readonly actorUserId: string; readonly requestId: string },
  ): Promise<Subscription | undefined> {
    // Enforces the full state machine in SQL. The domain transition table is the
    // source of truth for which `from` states may reach `status`; the UPDATE only
    // touches a row whose current status is one of those legal predecessors. A
    // no-op (illegal target / not found / already-terminal) updates 0 rows and
    // returns undefined. Terminal transitions stamp `ends_at` when it is unset;
    // suspend/resume leave the window untouched.
    const legalFrom = (
      ["active", "suspended", "canceled", "expired"] as const
    ).filter((from) => {
      try {
        assertSubscriptionTransition(from, status);
        return true;
      } catch {
        return false;
      }
    });
    if (legalFrom.length === 0) return undefined;
    const isTerminal = status === "canceled" || status === "expired";
    // Admin-only, cross-org status change: PLATFORM-GLOBAL audit
    // (organization_id = NULL) naming the affected org in after_summary. Run the
    // UPDATE and its audit row in ONE transaction so they commit together.
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<SubscriptionRow>(
        `UPDATE subscriptions s
         SET status = $2::subscription_status,
             ends_at = CASE WHEN $3::boolean AND s.ends_at IS NULL THEN now() ELSE s.ends_at END,
             version = s.version + 1,
             updated_at = now()
         FROM plans p
         WHERE s.id = $1 AND p.id = s.plan_id AND s.status = ANY($4::subscription_status[])
         RETURNING ${SELECT_COLUMNS}`,
        [id, status, isTerminal, legalFrom],
      );
      const row = result.rows[0];
      if (!row) {
        // Illegal / no-op transition: nothing changed, write no audit row.
        await client.query("ROLLBACK");
        return undefined;
      }
      const mapped = mapRow(row);
      await insertAuditEvent(client, {
        organizationId: null,
        actor: { actorUserId: actor.actorUserId },
        action: "subscription.status_changed",
        targetType: "subscription",
        targetId: id,
        beforeSummary: null,
        afterSummary: {
          organizationId: mapped.organizationId,
          status: mapped.status,
        },
        requestId: actor.requestId,
      });
      await client.query("COMMIT");
      return mapped;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // ignore — the transaction was already resolved.
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
