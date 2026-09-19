import { TRIAL_REQUEST_QUOTA } from "@sculpin/domain";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresSubscriptionRepository } from "./subscription.js";
import { PostgresPersonalTenantTransaction } from "./tenant.js";

/**
 * M4 subscription invariants against a real (ephemeral) PostgreSQL:
 *  - provisioning grants an active `trial` with the configured quota;
 *  - quota reservation is ATOMIC: under a concurrent last-quota stampede
 *    exactly `quota_limit` reservations succeed and `quota_used` never exceeds
 *    `quota_limit` (no read-compare-write over-draw — CLAUDE.md rule 6);
 *  - the state machine only transitions an active subscription to a terminal
 *    state, and a terminal subscription no longer entitles reservations.
 */
const enabled = process.env.RUN_DATABASE_INTEGRATION === "true";
const suite = enabled ? describe : describe.skip;

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

  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 12 });
    repository = new PostgresSubscriptionRepository(pool);
    tenant = new PostgresPersonalTenantTransaction(pool);
  });
  afterAll(() => pool?.end());

  it("provisioning grants an active trial with the configured quota", async () => {
    const organizationId = await provisionOrg();
    const subscriptions =
      await repository.listForOrganization(organizationId);
    expect(subscriptions).toHaveLength(1);
    const trial = subscriptions[0]!;
    expect(trial.plan).toBe("trial");
    expect(trial.status).toBe("active");
    expect(trial.quotaLimit).toBe(TRIAL_REQUEST_QUOTA);
    expect(trial.quotaUsed).toBe(0);
    expect(trial.endsAt).toBeUndefined();
  });

  it("reserves quota atomically and reports remaining", async () => {
    const organizationId = await provisionOrg();
    const first = await repository.reserveQuota(organizationId, 5);
    expect(first.granted).toBe(true);
    expect(first.remainingQuota).toBe(TRIAL_REQUEST_QUOTA - 5);
    const second = await repository.reserveQuota(organizationId, 3);
    expect(second.granted).toBe(true);
    expect(second.remainingQuota).toBe(TRIAL_REQUEST_QUOTA - 8);
  });

  it("denies a reservation with no active subscription", async () => {
    const organizationId = await provisionOrg();
    // Fresh org with no subscriptions of its own: cancel the trial so nothing
    // is active.
    const [trial] = await repository.listForOrganization(organizationId);
    await repository.setStatus(trial!.id, "canceled");
    const denied = await repository.reserveQuota(organizationId, 1);
    expect(denied.granted).toBe(false);
    expect(denied.remainingQuota).toBe(0);
  });

  it("never over-draws under a concurrent last-quota stampede", async () => {
    const organizationId = await provisionOrg();
    const [trial] = await repository.listForOrganization(organizationId);
    // Shrink the budget to a small last-quota window.
    await pool.query(
      "UPDATE subscriptions SET quota_limit=5, quota_used=0 WHERE id=$1",
      [trial!.id],
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
      [trial!.id],
    );
    expect(Number(rows[0]?.quota_used)).toBe(5);
    expect(Number(rows[0]?.quota_used)).toBeLessThanOrEqual(
      Number(rows[0]?.quota_limit),
    );
  });

  it("enforces the state machine and stops entitling after a terminal state", async () => {
    const organizationId = await provisionOrg();
    const [trial] = await repository.listForOrganization(organizationId);
    const canceled = await repository.setStatus(trial!.id, "canceled");
    expect(canceled?.status).toBe("canceled");
    expect(canceled?.endsAt).toBeInstanceOf(Date);
    // A second terminal transition is a no-op (already terminal).
    expect(await repository.setStatus(trial!.id, "expired")).toBeUndefined();
    // Terminal subscription no longer permits reservations.
    const denied = await repository.reserveQuota(organizationId, 1);
    expect(denied.granted).toBe(false);
  });

  it("pools quota across the union of active subscriptions", async () => {
    const organizationId = await provisionOrg();
    // Cancel the trial and add two active commercial subscriptions.
    const [trial] = await repository.listForOrganization(organizationId);
    await repository.setStatus(trial!.id, "canceled");
    await pool.query(
      "INSERT INTO subscriptions (organization_id, plan, status, quota_limit, quota_used) VALUES ($1,'commercial','active',10,8),($1,'commercial','active',10,9)",
      [organizationId],
    );
    // Pooled remaining is (10-8)+(10-9)=3; a reservation of 2 fits the first sub.
    const first = await repository.reserveQuota(organizationId, 2);
    expect(first.granted).toBe(true);
    // Now only the second sub has room for 1 more.
    const second = await repository.reserveQuota(organizationId, 1);
    expect(second.granted).toBe(true);
    const denied = await repository.reserveQuota(organizationId, 1);
    expect(denied.granted).toBe(false);
    expect(denied.remainingQuota).toBe(0);
  });
});
