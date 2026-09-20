import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresSubscriptionRepository } from "./subscription.js";
import { PostgresPersonalTenantTransaction } from "./tenant.js";

/**
 * S3 subscription invariants against a real (ephemeral) PostgreSQL (D-019):
 *  - provisioning grants NO subscription (explicit-claim journey);
 *  - `grantFromPlan` materializes an active subscription snapshotting the plan
 *    kind + catalogue-entry set;
 *  - quota reservation is ATOMIC: under a concurrent last-quota stampede exactly
 *    `quota_limit` reservations succeed and `quota_used` never exceeds
 *    `quota_limit` (no read-compare-write over-draw — CLAUDE.md rule 6);
 *  - the state machine supports suspend/resume (suspended is not entitling) and
 *    terminal transitions, after which the subscription no longer entitles.
 */
const enabled = process.env.RUN_DATABASE_INTEGRATION === "true";
const suite = enabled ? describe : describe.skip;

const FREE_TRIAL_PLAN_ID = "00000000-0000-4000-8000-0000000f7a11";
const ACTOR = "00000000-0000-4000-8000-000000000abc";

suite("subscription repository", () => {
  let pool: pg.Pool;
  let repository: PostgresSubscriptionRepository;
  let tenant: PostgresPersonalTenantTransaction;
  let seq = 0;

  async function provisionOrg(): Promise<string> {
    seq += 1;
    const result = await tenant.create({
      normalizedEmail: `sub-${seq}@example.com`,
      displayName: `Sub Tenant ${seq}`,
      locale: "en",
      organizationSlug: `sub-tenant-${seq}`,
      requestId: `sub-tenant-${seq}`,
    });
    return result.organizationId;
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
    const { requestQuota = 200, oneTime = false, durationDays = null } =
      overrides;
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

  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 12 });
    repository = new PostgresSubscriptionRepository(pool);
    tenant = new PostgresPersonalTenantTransaction(pool);
  });
  afterAll(() => pool?.end());

  it("provisioning grants NO subscription (explicit-claim journey)", async () => {
    const organizationId = await provisionOrg();
    const subscriptions = await repository.listForOrganization(organizationId);
    expect(subscriptions).toHaveLength(0);
  });

  it("grantFromPlan materializes an active subscription with the plan quota", async () => {
    const organizationId = await provisionOrg();
    const granted = await repository.grantFromPlan(
      organizationId,
      FREE_TRIAL_PLAN_ID,
      ACTOR,
    );
    expect(granted.status).toBe("active");
    expect(granted.planKind).toBe("free_trial");
    expect(granted.planKey).toBe("free-trial");
    expect(granted.quotaLimit).toBe(200);
    expect(granted.quotaUsed).toBe(0);
    expect(granted.endsAt).toBeUndefined();
    const subscriptions = await repository.listForOrganization(organizationId);
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]!.offerings).toEqual([]);
  });

  it("rejects granting a disabled plan", async () => {
    const organizationId = await provisionOrg();
    const planId = await createPlan();
    await pool.query("UPDATE plans SET enabled=false WHERE id=$1", [planId]);
    await expect(
      repository.grantFromPlan(organizationId, planId, ACTOR),
    ).rejects.toThrow(/disabled/i);
    expect(await repository.listForOrganization(organizationId)).toHaveLength(0);
  });

  it("reserves quota atomically and reports remaining", async () => {
    const organizationId = await provisionOrg();
    await repository.grantFromPlan(organizationId, FREE_TRIAL_PLAN_ID, ACTOR);
    const first = await repository.reserveQuota(organizationId, 5);
    expect(first.granted).toBe(true);
    expect(first.remainingQuota).toBe(200 - 5);
    const second = await repository.reserveQuota(organizationId, 3);
    expect(second.granted).toBe(true);
    expect(second.remainingQuota).toBe(200 - 8);
  });

  it("denies a reservation with no active subscription", async () => {
    const organizationId = await provisionOrg();
    const denied = await repository.reserveQuota(organizationId, 1);
    expect(denied.granted).toBe(false);
    expect(denied.remainingQuota).toBe(0);
  });

  it("never over-draws under a concurrent last-quota stampede", async () => {
    const organizationId = await provisionOrg();
    const sub = await repository.grantFromPlan(
      organizationId,
      FREE_TRIAL_PLAN_ID,
      ACTOR,
    );
    // Shrink the budget to a small last-quota window.
    await pool.query(
      "UPDATE subscriptions SET quota_limit=5, quota_used=0 WHERE id=$1",
      [sub.id],
    );
    const attempts = 25;
    const results = await Promise.all(
      Array.from({ length: attempts }, () =>
        repository.reserveQuota(organizationId, 1),
      ),
    );
    const granted = results.filter((r) => r.granted).length;
    expect(granted).toBe(5);
    const { rows } = await pool.query<{ quota_used: number; quota_limit: number }>(
      "SELECT quota_used, quota_limit FROM subscriptions WHERE id=$1",
      [sub.id],
    );
    expect(Number(rows[0]?.quota_used)).toBe(5);
    expect(Number(rows[0]?.quota_used)).toBeLessThanOrEqual(
      Number(rows[0]?.quota_limit),
    );
  });

  it("supports suspend/resume lifecycle then terminal cancellation", async () => {
    const organizationId = await provisionOrg();
    const sub = await repository.grantFromPlan(
      organizationId,
      FREE_TRIAL_PLAN_ID,
      ACTOR,
    );
    // Suspend: no longer entitling.
    const suspended = await repository.setStatus(sub.id, "suspended");
    expect(suspended?.status).toBe("suspended");
    expect((await repository.reserveQuota(organizationId, 1)).granted).toBe(
      false,
    );
    // Resume: entitling again.
    const resumed = await repository.setStatus(sub.id, "active");
    expect(resumed?.status).toBe("active");
    expect((await repository.reserveQuota(organizationId, 1)).granted).toBe(
      true,
    );
    // Cancel (terminal): stamps ends_at and no longer entitles.
    const canceled = await repository.setStatus(sub.id, "canceled");
    expect(canceled?.status).toBe("canceled");
    expect(canceled?.endsAt).toBeInstanceOf(Date);
    expect(await repository.setStatus(sub.id, "expired")).toBeUndefined();
    expect((await repository.reserveQuota(organizationId, 1)).granted).toBe(
      false,
    );
  });

  it("pools quota across the union of active subscriptions", async () => {
    const organizationId = await provisionOrg();
    const planA = await createPlan({ requestQuota: 10 });
    const planB = await createPlan({ requestQuota: 10 });
    const subA = await repository.grantFromPlan(organizationId, planA, ACTOR);
    const subB = await repository.grantFromPlan(organizationId, planB, ACTOR);
    await pool.query("UPDATE subscriptions SET quota_used=8 WHERE id=$1", [
      subA.id,
    ]);
    await pool.query("UPDATE subscriptions SET quota_used=9 WHERE id=$1", [
      subB.id,
    ]);
    // Pooled remaining is (10-8)+(10-9)=3; a reservation of 2 fits the first sub.
    expect((await repository.reserveQuota(organizationId, 2)).granted).toBe(
      true,
    );
    expect((await repository.reserveQuota(organizationId, 1)).granted).toBe(
      true,
    );
    const denied = await repository.reserveQuota(organizationId, 1);
    expect(denied.granted).toBe(false);
    expect(denied.remainingQuota).toBe(0);
  });
});
