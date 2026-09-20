import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresAuditLogRepository } from "./audit-log.js";
import { PostgresUsageSummaryRepository } from "./audit-log.js";
import { PostgresCatalogueRepository } from "./catalogue.js";
import { PostgresPatService, type PatKeyring } from "./pat.js";
import { PostgresSubscriptionRepository } from "./subscription.js";
import { PostgresPersonalTenantTransaction } from "./tenant.js";

/**
 * §11 read-view invariants against a real (ephemeral) PostgreSQL. Drives the
 * REAL repositories to CREATE the source rows (a catalogue-entry create audit
 * — platform-global, NULL org — and a self-service subscription claim audit —
 * org-scoped) plus real usage rows via `reserveQuota`, then asserts:
 *   - `listRecent` returns rows NEWEST-FIRST with resolved actor email / org
 *     slug (NULL slug for a platform-global event);
 *   - the usage summary aggregates count(*) and sum(quota_cost) correctly with
 *     a per-organization top-N breakdown.
 * Self-skips unless RUN_DATABASE_INTEGRATION=true (no Postgres in the sandbox).
 */
const enabled = process.env.RUN_DATABASE_INTEGRATION === "true";
const suite = enabled ? describe : describe.skip;

const PAT_KEY = "integration-auditlog-pat-hash-secret-0123456789abcdef";
const KEYRING: PatKeyring = { currentVersion: 1, keys: new Map([[1, PAT_KEY]]) };

suite("§11 admin audit/usage read views (real repositories)", () => {
  let pool: pg.Pool;
  let auditLog: PostgresAuditLogRepository;
  let usageSummary: PostgresUsageSummaryRepository;
  let catalogue: PostgresCatalogueRepository;
  let subscriptions: PostgresSubscriptionRepository;
  let pats: PostgresPatService;
  let tenant: PostgresPersonalTenantTransaction;
  let seq = 0;

  async function provisionOrg(): Promise<{
    userId: string;
    organizationId: string;
    slug: string;
    email: string;
  }> {
    seq += 1;
    const email = `auditlog-${seq}@example.com`;
    const slug = `auditlog-tenant-${seq}`;
    const { userId, organizationId } = await tenant.create({
      normalizedEmail: email,
      displayName: `AuditLog Tenant ${seq}`,
      locale: "en",
      organizationSlug: slug,
      requestId: `auditlog-tenant-${seq}`,
    });
    return { userId, organizationId, slug, email };
  }

  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
    auditLog = new PostgresAuditLogRepository(pool);
    usageSummary = new PostgresUsageSummaryRepository(pool);
    catalogue = new PostgresCatalogueRepository(pool);
    subscriptions = new PostgresSubscriptionRepository(pool);
    pats = new PostgresPatService(pool, KEYRING);
    tenant = new PostgresPersonalTenantTransaction(pool);
  });
  afterAll(() => pool?.end());

  it("listRecent returns rows newest-first with resolved actor email and org slug", async () => {
    const admin = await provisionOrg();
    seq += 1;
    // Platform-global catalogue create (organization_id = NULL): actor resolves
    // to the admin email, org slug resolves to NULL.
    const entry = await catalogue.create(
      {
        publicAlias: `auditlog-cat-${seq}`,
        upstreamAgentId: `agent-auditlog-${seq}`,
        displayName: `AuditLog Cat ${seq}`,
      },
      admin.userId,
      "req-auditlog-cat",
    );

    // Org-scoped self-service claim: actor + org resolve to the claimer's tenant.
    seq += 1;
    const plan = await pool.query<{ id: string }>(
      `INSERT INTO plans (key, name, kind, enabled, published, request_quota, self_service_eligible)
       VALUES ($1,$2,'free_trial',true,true,50,true) RETURNING id`,
      [`auditlog-plan-${seq}`, `AuditLog Plan ${seq}`],
    );
    const planId = plan.rows[0]!.id;
    await pool.query(
      `INSERT INTO plan_catalogue_entries (plan_id, catalogue_entry_id)
       VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [planId, entry.id],
    );
    const claimer = await provisionOrg();
    const sub = await subscriptions.grantFromPlan(claimer.organizationId, planId, {
      actorUserId: claimer.userId,
      requestId: "req-auditlog-claim",
      viaAdmin: false,
    });

    const recent = await auditLog.listRecent(200);
    const catRow = recent.find(
      (r) => r.targetId === entry.id && r.action === "catalogue_entry.created",
    );
    const claimRow = recent.find(
      (r) => r.targetId === sub.id && r.action === "subscription.self_claimed",
    );
    expect(catRow).toBeDefined();
    expect(claimRow).toBeDefined();

    // Platform-global catalogue create: actor email resolved, org slug NULL.
    expect(catRow!.actorEmail).toBe(admin.email);
    expect(catRow!.actorUserId).toBe(admin.userId);
    expect(catRow!.systemActor).toBeNull();
    expect(catRow!.organizationId).toBeNull();
    expect(catRow!.organizationSlug).toBeNull();
    expect(typeof catRow!.occurredAt).toBe("string");
    // The upstream agent id NEVER surfaces in the projected summary.
    expect(JSON.stringify(catRow!.afterSummary)).not.toMatch(/agent-auditlog/);

    // Org-scoped claim: actor email + org slug both resolve.
    expect(claimRow!.actorEmail).toBe(claimer.email);
    expect(claimRow!.organizationId).toBe(claimer.organizationId);
    expect(claimRow!.organizationSlug).toBe(claimer.slug);

    // Newest-first: the later-created claim precedes the earlier catalogue row.
    const catIndex = recent.indexOf(catRow!);
    const claimIndex = recent.indexOf(claimRow!);
    expect(claimIndex).toBeLessThan(catIndex);
    // Global order is monotonically non-increasing by occurredAt.
    for (let i = 1; i < recent.length; i += 1) {
      expect(recent[i - 1]!.occurredAt >= recent[i]!.occurredAt).toBe(true);
    }
  });

  it("summarize aggregates usage count and quota cost with a per-org breakdown", async () => {
    // Seed usage rows for one org through the REAL reserveQuota path.
    const { userId, organizationId, slug } = await provisionOrg();
    seq += 1;
    const offering = await catalogue.create(
      {
        publicAlias: `auditlog-usage-${seq}`,
        upstreamAgentId: `agent-usage-${seq}`,
        displayName: `AuditLog Usage ${seq}`,
      },
      userId,
      "req-auditlog-usage-off",
    );
    seq += 1;
    const plan = await pool.query<{ id: string }>(
      `INSERT INTO plans (key, name, kind, enabled, published, request_quota)
       VALUES ($1,$2,'free_trial',true,true,200) RETURNING id`,
      [`auditlog-usage-plan-${seq}`, `AuditLog Usage Plan ${seq}`],
    );
    const planId = plan.rows[0]!.id;
    await pool.query(
      `INSERT INTO plan_catalogue_entries (plan_id, catalogue_entry_id)
       VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [planId, offering.id],
    );
    await subscriptions.grantFromPlan(organizationId, planId, {
      actorUserId: userId,
      requestId: "req-auditlog-usage-grant",
      viaAdmin: false,
    });
    const { record } = await pats.mint({
      userId,
      organizationId,
      name: "auditlog-usage-pat",
      requestId: "req-auditlog-usage-mint",
    });
    const usageCtx = {
      catalogueEntryId: offering.id,
      patId: record.id,
      requestId: "req-auditlog-usage-reserve",
    };
    const before = await usageSummary.summarize();
    const r1 = await subscriptions.reserveQuota(organizationId, 5, usageCtx);
    expect(r1.granted).toBe(true);
    const r2 = await subscriptions.reserveQuota(organizationId, 3, usageCtx);
    expect(r2.granted).toBe(true);

    const after = await usageSummary.summarize(25);
    // Two new rows totalling 8 quota units were added by this test.
    expect(after.totalRequestCount).toBe(before.totalRequestCount + 2);
    expect(after.totalQuotaCost).toBe(before.totalQuotaCost + 8);
    const orgSlice = after.topOrganizations.find(
      (o) => o.organizationId === organizationId,
    );
    expect(orgSlice).toBeDefined();
    expect(orgSlice!.organizationSlug).toBe(slug);
    expect(orgSlice!.requestCount).toBe(2);
    expect(orgSlice!.totalQuotaCost).toBe(8);
  });
});
