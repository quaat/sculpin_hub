import { DomainConflictError } from "@sculpin/domain";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresPlanRepository } from "./plan.js";
import { PostgresSubscriptionRepository } from "./subscription.js";
import { PostgresPersonalTenantTransaction } from "./tenant.js";

/**
 * S3 plan-domain invariants against a real (ephemeral) PostgreSQL (D-019):
 *  - the seeded free-trial plan exists;
 *  - `grantFromPlan` SNAPSHOTS the plan's catalogue-entry set; editing
 *    `plan_catalogue_entries` AFTER the grant does NOT change the subscription's
 *    frozen offerings;
 *  - a second claim of a one-time plan fails with a `plan_already_claimed`
 *    conflict (23505 on `plan_claims`);
 *  - a non-one-time plan may be claimed repeatedly.
 */
const enabled = process.env.RUN_DATABASE_INTEGRATION === "true";
const suite = enabled ? describe : describe.skip;

const FREE_TRIAL_PLAN_ID = "00000000-0000-4000-8000-0000000f7a11";

suite("plan repository", () => {
  let pool: pg.Pool;
  let plans: PostgresPlanRepository;
  let subscriptions: PostgresSubscriptionRepository;
  let tenant: PostgresPersonalTenantTransaction;
  // Real users are required because plan/subscription audit rows carry a FK to
  // `users` on the actor. ADMIN is a real admin user (platform-global audit);
  // each provisioned org's owner is used as the self-service actor.
  let ADMIN: string;
  let seq = 0;

  // Returns the org id AND its owner user id (an active member — the valid
  // self-service actor whose org-scoped audit row satisfies the composite
  // membership FK).
  async function provisionOrg(): Promise<{
    organizationId: string;
    ownerUserId: string;
  }> {
    seq += 1;
    const result = await tenant.create({
      normalizedEmail: `plan-${seq}@example.com`,
      displayName: `Plan Tenant ${seq}`,
      locale: "en",
      organizationSlug: `plan-tenant-${seq}`,
      requestId: `plan-tenant-${seq}`,
    });
    return {
      organizationId: result.organizationId,
      ownerUserId: result.userId,
    };
  }

  async function createCatalogueEntry(): Promise<string> {
    seq += 1;
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO catalogue_entries (public_alias, upstream_agent_id, display_name, status)
       VALUES ($1,$2,$3,'published') RETURNING id`,
      [`alias-${seq}`, `agent-${seq}`, `Agent ${seq}`],
    );
    return rows[0]!.id;
  }

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
    plans = new PostgresPlanRepository(pool);
    subscriptions = new PostgresSubscriptionRepository(pool);
    tenant = new PostgresPersonalTenantTransaction(pool);
    const admin = await tenant.create({
      normalizedEmail: "plan-admin@example.com",
      displayName: "Plan Admin",
      locale: "en",
      organizationSlug: "plan-admin-org",
      requestId: "plan-admin",
    });
    ADMIN = admin.userId;
  });
  afterAll(() => pool?.end());

  it("has the seeded free-trial plan", async () => {
    const plan = await plans.findByKey("free-trial");
    expect(plan?.id).toBe(FREE_TRIAL_PLAN_ID);
    expect(plan?.kind).toBe("free_trial");
    expect(plan?.enabled).toBe(true);
    expect(plan?.published).toBe(true);
    expect(plan?.oneTimePerOrganization).toBe(true);
    expect(plan?.requestQuota).toBe(200);
  });

  it("create + attach exposes the authoritative catalogue-entry set", async () => {
    seq += 1;
    const plan = await plans.create(
      {
        key: `authoritative-${seq}`,
        name: "Authoritative",
        kind: "commercial_monthly",
        requestQuota: 1000,
        durationDays: 30,
      },
      ADMIN,
      "req-plan-create",
    );
    const entry = await createCatalogueEntry();
    const attached = await plans.attachCatalogueEntry(
      plan.id,
      entry,
      ADMIN,
      "req-attach",
    );
    expect(attached?.catalogueEntryIds).toEqual([entry]);
    const detached = await plans.detachCatalogueEntry(
      plan.id,
      entry,
      ADMIN,
      "req-detach",
    );
    expect(detached?.catalogueEntryIds).toEqual([]);

    // No-op attach/detach must write NO audit row (invariant every path honors).
    const auditCount = async (requestId: string): Promise<number> => {
      const { rows } = await pool.query(
        "SELECT count(*)::int AS n FROM audit_events WHERE request_id = $1",
        [requestId],
      );
      return (rows[0] as { n: number }).n;
    };
    await plans.detachCatalogueEntry(plan.id, entry, ADMIN, "req-detach-noop");
    await plans.attachCatalogueEntry(plan.id, entry, ADMIN, "req-attach-again");
    await plans.attachCatalogueEntry(
      plan.id,
      entry,
      ADMIN,
      "req-attach-conflict-noop",
    );
    expect(await auditCount("req-attach")).toBe(1);
    expect(await auditCount("req-detach")).toBe(1);
    expect(await auditCount("req-detach-noop")).toBe(0);
    expect(await auditCount("req-attach-again")).toBe(1);
    expect(await auditCount("req-attach-conflict-noop")).toBe(0);
  });

  it("grantFromPlan snapshots offerings; later plan edits do not change them", async () => {
    seq += 1;
    const plan = await plans.create(
      {
        key: `snapshot-${seq}`,
        name: "Snapshot",
        kind: "commercial_monthly",
        requestQuota: 500,
      },
      ADMIN,
      "req-plan-create",
    );
    const entryA = await createCatalogueEntry();
    const entryB = await createCatalogueEntry();
    await plans.attachCatalogueEntry(plan.id, entryA, ADMIN, "req-attach-a");
    await plans.attachCatalogueEntry(plan.id, entryB, ADMIN, "req-attach-b");

    const { organizationId, ownerUserId } = await provisionOrg();
    const sub = await subscriptions.grantFromPlan(organizationId, plan.id, {
      actorUserId: ownerUserId,
      requestId: "req-grant",
      viaAdmin: false,
    });
    expect([...sub.offerings].sort()).toEqual([entryA, entryB].sort());

    // Edit the plan's authoritative mapping AFTER the grant: detach one, attach a new one.
    await plans.detachCatalogueEntry(plan.id, entryA, ADMIN, "req-detach-a");
    const entryC = await createCatalogueEntry();
    await plans.attachCatalogueEntry(plan.id, entryC, ADMIN, "req-attach-c");

    // The subscription's frozen snapshot is unchanged.
    const [reloaded] = await subscriptions.listForOrganization(organizationId);
    expect([...reloaded!.offerings].sort()).toEqual([entryA, entryB].sort());
  });

  it("rejects a second claim of a one-time plan", async () => {
    const { organizationId, ownerUserId } = await provisionOrg();
    const grant = {
      actorUserId: ownerUserId,
      requestId: "req-grant-1",
      viaAdmin: false,
    } as const;
    await subscriptions.grantFromPlan(organizationId, FREE_TRIAL_PLAN_ID, grant);
    await expect(
      subscriptions.grantFromPlan(organizationId, FREE_TRIAL_PLAN_ID, {
        ...grant,
        requestId: "req-grant-2",
      }),
    ).rejects.toMatchObject({
      name: "DomainConflictError",
      code: "plan_already_claimed",
    });
    // Exactly one subscription and one claim row exist.
    expect(
      await subscriptions.listForOrganization(organizationId),
    ).toHaveLength(1);
    const claims = await pool.query(
      "SELECT 1 FROM plan_claims WHERE organization_id=$1 AND plan_id=$2",
      [organizationId, FREE_TRIAL_PLAN_ID],
    );
    expect(claims.rowCount).toBe(1);
  });

  it("allows repeated claims of a non-one-time plan", async () => {
    seq += 1;
    const plan = await plans.create(
      {
        key: `repeatable-${seq}`,
        name: "Repeatable",
        kind: "commercial_monthly",
        requestQuota: 100,
      },
      ADMIN,
      "req-plan-create",
    );
    const { organizationId, ownerUserId } = await provisionOrg();
    await subscriptions.grantFromPlan(organizationId, plan.id, {
      actorUserId: ownerUserId,
      requestId: "req-grant-1",
      viaAdmin: false,
    });
    await subscriptions.grantFromPlan(organizationId, plan.id, {
      actorUserId: ownerUserId,
      requestId: "req-grant-2",
      viaAdmin: false,
    });
    expect(
      await subscriptions.listForOrganization(organizationId),
    ).toHaveLength(2);
    // No claim rows are written for a non-one-time plan.
    const claims = await pool.query(
      "SELECT 1 FROM plan_claims WHERE organization_id=$1 AND plan_id=$2",
      [organizationId, plan.id],
    );
    expect(claims.rowCount).toBe(0);
  });

  it("throws a validation error (not a conflict) for a missing plan", async () => {
    const { organizationId, ownerUserId } = await provisionOrg();
    const missing = "00000000-0000-4000-8000-000000000000";
    let caught: unknown;
    try {
      await subscriptions.grantFromPlan(organizationId, missing, {
        actorUserId: ownerUserId,
        requestId: "req-grant",
        viaAdmin: false,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/does not exist/i);
    expect(caught).not.toBeInstanceOf(DomainConflictError);
  });
});
