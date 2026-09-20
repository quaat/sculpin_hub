import type { UsageContext } from "@sculpin/domain";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresCatalogueRepository } from "./catalogue.js";
import { PostgresPatService, type PatKeyring } from "./pat.js";
import { PostgresSubscriptionRepository } from "./subscription.js";
import { PostgresPersonalTenantTransaction } from "./tenant.js";

/**
 * S3 subscription invariants against a real (ephemeral) PostgreSQL (D-019),
 * extended for the P0 OFFERING-BOUND quota fix:
 *  - provisioning grants NO subscription (explicit-claim journey);
 *  - `grantFromPlan` materializes an active subscription snapshotting the plan
 *    kind + catalogue-entry set;
 *  - quota reservation is ATOMIC and OFFERING-BOUND: quota is drawn ONLY from an
 *    active, in-window subscription whose FROZEN snapshot grants the requested
 *    offering. Quota held by a subscription that does not grant the offering is
 *    NEVER usable; a denial reports only the requested offering's remaining
 *    budget (CLAUDE.md rule 6);
 *  - under a concurrent last-quota stampede exactly `quota_limit` reservations
 *    succeed and `quota_used` never exceeds `quota_limit` (no read-compare-write
 *    over-draw), including when pooling across several subscriptions that grant
 *    the SAME offering;
 *  - every granted usage_events row's subscription_id identifies a subscription
 *    whose snapshot contains the recorded catalogue_entry_id;
 *  - the state machine supports suspend/resume (suspended is not entitling) and
 *    terminal transitions, after which the subscription no longer entitles.
 */
const enabled = process.env.RUN_DATABASE_INTEGRATION === "true";
const suite = enabled ? describe : describe.skip;

const FREE_TRIAL_PLAN_ID = "00000000-0000-4000-8000-0000000f7a11";
const PAT_KEY = "integration-subscription-usage-hash-0123456789abcdef";
const KEYRING: PatKeyring = {
  currentVersion: 1,
  keys: new Map([[1, PAT_KEY]]),
};

suite("subscription repository", () => {
  let pool: pg.Pool;
  let repository: PostgresSubscriptionRepository;
  let tenant: PostgresPersonalTenantTransaction;
  let catalogue: PostgresCatalogueRepository;
  let pats: PostgresPatService;
  let seq = 0;

  async function provisionOrg(): Promise<{
    userId: string;
    organizationId: string;
  }> {
    seq += 1;
    return tenant.create({
      normalizedEmail: `sub-${seq}@example.com`,
      displayName: `Sub Tenant ${seq}`,
      locale: "en",
      organizationSlug: `sub-tenant-${seq}`,
      requestId: `sub-tenant-${seq}`,
    });
  }

  /** Create a catalogue entry (an "offering") and return its id. */
  async function createOffering(userId: string): Promise<string> {
    seq += 1;
    const entry = await catalogue.create(
      {
        publicAlias: `off-${seq}`,
        upstreamAgentId: `agent-off-${seq}`,
        displayName: `Offering ${seq}`,
      },
      userId,
      `req-off-${seq}`,
    );
    return entry.id;
  }

  /**
   * Attach an offering to a plan so a subsequent `grantFromPlan` snapshots it
   * onto the subscription. Direct INSERT mirrors the plan repository's attach
   * (which is exercised by its own suite); here we only need the snapshot state.
   */
  async function attachOffering(
    planId: string,
    catalogueEntryId: string,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO plan_catalogue_entries (plan_id, catalogue_entry_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [planId, catalogueEntryId],
    );
  }

  /**
   * Build a real usage context for a SPECIFIC offering (a catalogue entry + a PAT
   * row both exist) so the usage_events FKs are satisfiable. `pat_id` is the PAT
   * ROW id, never a secret.
   */
  async function mintUsage(
    userId: string,
    organizationId: string,
    catalogueEntryId: string,
  ): Promise<UsageContext> {
    seq += 1;
    const { record } = await pats.mint({
      userId,
      organizationId,
      name: `usage-${seq}`,
      requestId: `usage-mint-${seq}`,
    });
    return {
      catalogueEntryId,
      patId: record.id,
      requestId: `usage-req-${seq}`,
    };
  }

  async function usageRowCount(organizationId: string): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM usage_events WHERE organization_id=$1",
      [organizationId],
    );
    return Number(rows[0]?.n ?? 0);
  }

  async function quotaUsed(subscriptionId: string): Promise<number> {
    const { rows } = await pool.query<{ quota_used: number }>(
      "SELECT quota_used FROM subscriptions WHERE id=$1",
      [subscriptionId],
    );
    return Number(rows[0]?.quota_used ?? -1);
  }

  /** Create a fresh, uniquely-keyed plan for a test to claim. */
  async function createPlan(
    overrides: {
      requestQuota?: number;
      oneTime?: boolean;
      durationDays?: number | null;
    } = {},
  ): Promise<string> {
    seq += 1;
    const {
      requestQuota = 200,
      oneTime = false,
      durationDays = null,
    } = overrides;
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO plans (key, name, kind, enabled, published, request_quota, one_time_per_organization, duration_days)
       VALUES ($1,$2,'free_trial',true,true,$3,$4,$5) RETURNING id`,
      [
        `test-plan-${seq}`,
        `Test Plan ${seq}`,
        requestQuota,
        oneTime,
        durationDays,
      ],
    );
    return rows[0]!.id;
  }

  /**
   * Grant a fresh plan that attaches `catalogueEntryId`, so the resulting
   * subscription's snapshot grants that offering. Returns the subscription id.
   */
  async function grantWithOffering(
    organizationId: string,
    catalogueEntryId: string,
    actorUserId: string,
    overrides: { requestQuota?: number; durationDays?: number | null } = {},
  ): Promise<string> {
    const planId = await createPlan(overrides);
    await attachOffering(planId, catalogueEntryId);
    const sub = await repository.grantFromPlan(organizationId, planId, {
      actorUserId,
      requestId: `grant-${planId}`,
      viaAdmin: false,
    });
    return sub.id;
  }

  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 12 });
    repository = new PostgresSubscriptionRepository(pool);
    tenant = new PostgresPersonalTenantTransaction(pool);
    catalogue = new PostgresCatalogueRepository(pool);
    pats = new PostgresPatService(pool, KEYRING);
  });
  afterAll(() => pool?.end());

  it("provisioning grants NO subscription (explicit-claim journey)", async () => {
    const { organizationId } = await provisionOrg();
    const subscriptions = await repository.listForOrganization(organizationId);
    expect(subscriptions).toHaveLength(0);
  });

  it("grantFromPlan materializes an active subscription with the plan quota", async () => {
    const { userId, organizationId } = await provisionOrg();
    const granted = await repository.grantFromPlan(
      organizationId,
      FREE_TRIAL_PLAN_ID,
      { actorUserId: userId, requestId: "grant-free-trial", viaAdmin: false },
    );
    expect(granted.status).toBe("active");
    expect(granted.planKind).toBe("free_trial");
    expect(granted.planKey).toBe("free-trial");
    expect(granted.quotaLimit).toBe(200);
    expect(granted.quotaUsed).toBe(0);
    expect(granted.endsAt).toBeUndefined();
    const subscriptions = await repository.listForOrganization(organizationId);
    expect(subscriptions).toHaveLength(1);
    // The seed free-trial plan attaches no offerings, so its snapshot is empty.
    expect(subscriptions[0]!.offerings).toEqual([]);
  });

  it("rejects granting a disabled plan", async () => {
    const { userId, organizationId } = await provisionOrg();
    const planId = await createPlan();
    await pool.query("UPDATE plans SET enabled=false WHERE id=$1", [planId]);
    await expect(
      repository.grantFromPlan(organizationId, planId, {
        actorUserId: userId,
        requestId: "grant-disabled",
        viaAdmin: false,
      }),
    ).rejects.toThrow(/disabled/i);
    expect(await repository.listForOrganization(organizationId)).toHaveLength(0);
  });

  it("reserves offering-bound quota atomically and records a matching usage row", async () => {
    const { userId, organizationId } = await provisionOrg();
    const offering = await createOffering(userId);
    const subId = await grantWithOffering(organizationId, offering, userId, {
      requestQuota: 200,
    });
    const usage = await mintUsage(userId, organizationId, offering);
    const first = await repository.reserveQuota(organizationId, 5, usage);
    expect(first.granted).toBe(true);
    expect(first.remainingQuota).toBe(200 - 5);
    const second = await repository.reserveQuota(organizationId, 3, usage);
    expect(second.granted).toBe(true);
    expect(second.remainingQuota).toBe(200 - 8);
    // A GRANTED reservation writes exactly one usage_events row bound to the
    // subscription that granted the offering — and NO secret.
    const { rows } = await pool.query<{
      organization_id: string;
      subscription_id: string;
      catalogue_entry_id: string;
      pat_id: string;
      request_id: string;
      quota_cost: number;
    }>(
      `SELECT organization_id, subscription_id, catalogue_entry_id, pat_id, request_id, quota_cost
       FROM usage_events WHERE organization_id=$1 ORDER BY quota_cost`,
      [organizationId],
    );
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      organization_id: organizationId,
      subscription_id: subId,
      catalogue_entry_id: usage.catalogueEntryId,
      pat_id: usage.patId,
      request_id: usage.requestId,
      quota_cost: 5,
    });
    expect(Number(rows[0]?.quota_cost)).toBe(3);
  });

  it("denies a reservation with no active subscription and writes NO usage row", async () => {
    const { userId, organizationId } = await provisionOrg();
    const offering = await createOffering(userId);
    const usage = await mintUsage(userId, organizationId, offering);
    const denied = await repository.reserveQuota(organizationId, 1, usage);
    expect(denied.granted).toBe(false);
    expect(denied.remainingQuota).toBe(0);
    expect(await usageRowCount(organizationId)).toBe(0);
  });

  it("writes NO usage row when the reservation is denied for exhaustion", async () => {
    const { userId, organizationId } = await provisionOrg();
    const offering = await createOffering(userId);
    const subId = await grantWithOffering(organizationId, offering, userId, {
      requestQuota: 1,
    });
    await pool.query("UPDATE subscriptions SET quota_used=1 WHERE id=$1", [
      subId,
    ]);
    const usage = await mintUsage(userId, organizationId, offering);
    const denied = await repository.reserveQuota(organizationId, 1, usage);
    expect(denied.granted).toBe(false);
    expect(denied.remainingQuota).toBe(0);
    expect(await usageRowCount(organizationId)).toBe(0);
  });

  it("never over-draws under a concurrent last-quota stampede (single subscription)", async () => {
    const { userId, organizationId } = await provisionOrg();
    const offering = await createOffering(userId);
    const subId = await grantWithOffering(organizationId, offering, userId, {
      requestQuota: 5,
    });
    const usage = await mintUsage(userId, organizationId, offering);
    const attempts = 25;
    const results = await Promise.all(
      Array.from({ length: attempts }, () =>
        repository.reserveQuota(organizationId, 1, usage),
      ),
    );
    const granted = results.filter((r) => r.granted).length;
    expect(granted).toBe(5);
    expect(await quotaUsed(subId)).toBe(5);
    // KEY ATOMICITY ASSERTION: exactly one usage_events row per GRANTED
    // reservation — usage and quota commit together, so a denied loser leaves no
    // orphan usage row and a winner is never missing one.
    expect(await usageRowCount(organizationId)).toBe(5);
  });

  it("supports suspend/resume lifecycle then terminal cancellation", async () => {
    const { userId, organizationId } = await provisionOrg();
    const offering = await createOffering(userId);
    await grantWithOffering(organizationId, offering, userId, { requestQuota: 200 });
    const usage = await mintUsage(userId, organizationId, offering);
    const [sub] = await repository.listForOrganization(organizationId);
    const actor = { actorUserId: userId, requestId: "status-change" };
    // Suspend: no longer entitling.
    const suspended = await repository.setStatus(sub!.id, "suspended", actor);
    expect(suspended?.status).toBe("suspended");
    expect(
      (await repository.reserveQuota(organizationId, 1, usage)).granted,
    ).toBe(false);
    // Resume: entitling again.
    const resumed = await repository.setStatus(sub!.id, "active", actor);
    expect(resumed?.status).toBe("active");
    expect(
      (await repository.reserveQuota(organizationId, 1, usage)).granted,
    ).toBe(true);
    // Cancel (terminal): stamps ends_at and no longer entitles.
    const canceled = await repository.setStatus(sub!.id, "canceled", actor);
    expect(canceled?.status).toBe("canceled");
    expect(canceled?.endsAt).toBeInstanceOf(Date);
    expect(
      await repository.setStatus(sub!.id, "expired", actor),
    ).toBeUndefined();
    expect(
      (await repository.reserveQuota(organizationId, 1, usage)).granted,
    ).toBe(false);
    // Only the single granted reservation (while active) recorded a usage row.
    expect(await usageRowCount(organizationId)).toBe(1);
  });

  it("pools quota across multiple subscriptions granting the SAME offering", async () => {
    const { userId, organizationId } = await provisionOrg();
    const offering = await createOffering(userId);
    const subA = await grantWithOffering(organizationId, offering, userId, {
      requestQuota: 10,
    });
    const subB = await grantWithOffering(organizationId, offering, userId, {
      requestQuota: 10,
    });
    const usage = await mintUsage(userId, organizationId, offering);
    await pool.query("UPDATE subscriptions SET quota_used=8 WHERE id=$1", [
      subA,
    ]);
    await pool.query("UPDATE subscriptions SET quota_used=9 WHERE id=$1", [
      subB,
    ]);
    // Pooled remaining for the offering is (10-8)+(10-9)=3; a reservation of 2
    // fits the first eligible sub, then 1 more drains the pool.
    expect(
      (await repository.reserveQuota(organizationId, 2, usage)).granted,
    ).toBe(true);
    expect(
      (await repository.reserveQuota(organizationId, 1, usage)).granted,
    ).toBe(true);
    const denied = await repository.reserveQuota(organizationId, 1, usage);
    expect(denied.granted).toBe(false);
    expect(denied.remainingQuota).toBe(0);
    expect(await usageRowCount(organizationId)).toBe(2);
  });

  it("never over-draws when pooling across two subscriptions for the same offering", async () => {
    const { userId, organizationId } = await provisionOrg();
    const offering = await createOffering(userId);
    const subA = await grantWithOffering(organizationId, offering, userId, {
      requestQuota: 3,
    });
    const subB = await grantWithOffering(organizationId, offering, userId, {
      requestQuota: 2,
    });
    const usage = await mintUsage(userId, organizationId, offering);
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        repository.reserveQuota(organizationId, 1, usage),
      ),
    );
    // Exactly the pooled budget (3 + 2 = 5) may be granted, no more.
    expect(results.filter((r) => r.granted).length).toBe(5);
    expect(await quotaUsed(subA)).toBeLessThanOrEqual(3);
    expect(await quotaUsed(subB)).toBeLessThanOrEqual(2);
    expect((await quotaUsed(subA)) + (await quotaUsed(subB))).toBe(5);
    expect(await usageRowCount(organizationId)).toBe(5);
  });

  it("never spends quota from a subscription that does NOT grant the requested offering", async () => {
    const { userId, organizationId } = await provisionOrg();
    const offeringA = await createOffering(userId);
    const offeringB = await createOffering(userId);
    // Subscription A grants offering A but is exhausted.
    const subA = await grantWithOffering(organizationId, offeringA, userId, {
      requestQuota: 1,
    });
    await pool.query("UPDATE subscriptions SET quota_used=1 WHERE id=$1", [
      subA,
    ]);
    // Subscription B grants offering B and has ample quota.
    const subB = await grantWithOffering(organizationId, offeringB, userId, {
      requestQuota: 100,
    });
    const usageA = await mintUsage(userId, organizationId, offeringA);
    // A request for offering A must be DENIED — B's quota is unrelated and must
    // never be consumed for A.
    const denied = await repository.reserveQuota(organizationId, 1, usageA);
    expect(denied.granted).toBe(false);
    // Denied remaining reflects offering A only (exhausted), NOT offering B.
    expect(denied.remainingQuota).toBe(0);
    // B's quota is untouched and no usage row was written.
    expect(await quotaUsed(subB)).toBe(0);
    expect(await usageRowCount(organizationId)).toBe(0);
  });

  it("binds each usage row to a subscription whose snapshot contains its offering", async () => {
    const { userId, organizationId } = await provisionOrg();
    const offeringA = await createOffering(userId);
    const offeringB = await createOffering(userId);
    const subA = await grantWithOffering(organizationId, offeringA, userId, {
      requestQuota: 50,
    });
    const subB = await grantWithOffering(organizationId, offeringB, userId, {
      requestQuota: 50,
    });
    const usageA = await mintUsage(userId, organizationId, offeringA);
    const usageB = await mintUsage(userId, organizationId, offeringB);
    expect((await repository.reserveQuota(organizationId, 1, usageA)).granted).toBe(
      true,
    );
    expect((await repository.reserveQuota(organizationId, 1, usageB)).granted).toBe(
      true,
    );
    // Each granted reservation charged the subscription that actually grants the
    // requested offering; the other subscription is untouched.
    expect(await quotaUsed(subA)).toBe(1);
    expect(await quotaUsed(subB)).toBe(1);
    // Every usage_events row's subscription snapshot contains its catalogue_entry_id.
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM usage_events ue
        WHERE ue.organization_id = $1
          AND NOT EXISTS (
            SELECT 1 FROM subscription_catalogue_entries sce
             WHERE sce.subscription_id = ue.subscription_id
               AND sce.catalogue_entry_id = ue.catalogue_entry_id
          )`,
      [organizationId],
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });
});
