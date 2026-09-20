import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresCatalogueRepository } from "./catalogue.js";
import { PostgresPatService, type PatKeyring } from "./pat.js";
import { PostgresPlanRepository } from "./plan.js";
import { PostgresSubscriptionRepository } from "./subscription.js";
import { PostgresPersonalTenantTransaction } from "./tenant.js";

/**
 * §10 audit-event invariants against a real (ephemeral) PostgreSQL: driving the
 * REAL repositories (never a fabricated INSERT), assert that each audited
 * control-plane mutation writes EXACTLY ONE `audit_events` row with:
 *  - the correct action / target_type / target_id / actor;
 *  - the correct scope: org-scoped (organization_id = the tenant org) for
 *    self-service; PLATFORM-GLOBAL (organization_id = NULL) for catalogue/plan
 *    CRUD and admin cross-org subscription grants, naming the affected org in
 *    after_summary;
 *  - SAFE metadata ONLY. A catalogue audit summary carries `publicAlias` but
 *    NEVER `upstreamAgentId`; a PAT mint summary carries NO token/secret/hash/
 *    digest key. A raw scan of every summary never contains the upstream agent
 *    id nor any credential-shaped key.
 */
const enabled = process.env.RUN_DATABASE_INTEGRATION === "true";
const suite = enabled ? describe : describe.skip;

const PAT_KEY = "integration-audit-pat-hash-secret-0123456789abcdef";
const KEYRING: PatKeyring = { currentVersion: 1, keys: new Map([[1, PAT_KEY]]) };

interface AuditRow {
  readonly organization_id: string | null;
  readonly actor_user_id: string | null;
  readonly system_actor: string | null;
  readonly action: string;
  readonly target_type: string;
  readonly target_id: string;
  readonly before_summary: Record<string, unknown> | null;
  readonly after_summary: Record<string, unknown> | null;
  readonly request_id: string;
}

suite("audit events (real repositories)", () => {
  let pool: pg.Pool;
  let catalogue: PostgresCatalogueRepository;
  let plans: PostgresPlanRepository;
  let subscriptions: PostgresSubscriptionRepository;
  let pats: PostgresPatService;
  let tenant: PostgresPersonalTenantTransaction;
  let seq = 0;

  async function provisionOrg(): Promise<{
    userId: string;
    organizationId: string;
  }> {
    seq += 1;
    return tenant.create({
      normalizedEmail: `audit-${seq}@example.com`,
      displayName: `Audit Tenant ${seq}`,
      locale: "en",
      organizationSlug: `audit-tenant-${seq}`,
      requestId: `audit-tenant-${seq}`,
    });
  }

  /** All audit rows for a target, oldest first. */
  async function rowsForTarget(targetId: string): Promise<AuditRow[]> {
    const { rows } = await pool.query<AuditRow>(
      `SELECT organization_id, actor_user_id, system_actor, action, target_type,
              target_id, before_summary, after_summary, request_id
         FROM audit_events WHERE target_id = $1 ORDER BY occurred_at, action`,
      [targetId],
    );
    return rows;
  }

  /** Assert a summary carries only safe metadata (no credential/agent-id keys). */
  function expectSafeSummary(summary: Record<string, unknown> | null): void {
    const serialized = JSON.stringify(summary ?? {});
    expect(serialized).not.toMatch(/upstreamAgentId/i);
    expect(serialized).not.toMatch(/agent-/); // upstream agent id value shape
    expect(serialized).not.toMatch(/secret|hash|digest|sclp_pat|bearer|token/i);
  }

  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
    catalogue = new PostgresCatalogueRepository(pool);
    plans = new PostgresPlanRepository(pool);
    subscriptions = new PostgresSubscriptionRepository(pool);
    pats = new PostgresPatService(pool, KEYRING);
    tenant = new PostgresPersonalTenantTransaction(pool);
  });
  afterAll(() => pool?.end());

  it("audits catalogue create then publish as PLATFORM-GLOBAL rows, never leaking the upstream agent id", async () => {
    const { userId } = await provisionOrg();
    seq += 1;
    const entry = await catalogue.create(
      {
        publicAlias: `audit-cat-${seq}`,
        upstreamAgentId: `agent-secret-${seq}`,
        displayName: `Audit Cat ${seq}`,
      },
      userId,
      "req-audit-cat-create",
    );
    await catalogue.publish(entry.id, userId, "req-audit-cat-publish");

    const rows = await rowsForTarget(entry.id);
    const byAction = new Map(rows.map((r) => [r.action, r]));
    const created = byAction.get("catalogue_entry.created");
    const published = byAction.get("catalogue_entry.published");
    expect(created).toBeDefined();
    expect(published).toBeDefined();

    for (const row of [created!, published!]) {
      // Catalogue CRUD is platform-global; the responsible admin is the actor.
      expect(row.organization_id).toBeNull();
      expect(row.actor_user_id).toBe(userId);
      expect(row.system_actor).toBeNull();
      expect(row.target_type).toBe("catalogue_entry");
      expect(row.target_id).toBe(entry.id);
      // upstreamAgentId is NEVER present on any catalogue audit summary.
      expect(Object.keys(row.after_summary ?? {})).not.toContain(
        "upstreamAgentId",
      );
      expectSafeSummary(row.after_summary);
    }
    // The create summary carries the public alias (safe metadata); the publish
    // summary carries only the new status.
    expect(Object.keys(created!.after_summary ?? {})).toContain("publicAlias");
    expect(published!.after_summary).toEqual({ status: "published" });
    expect(created!.request_id).toBe("req-audit-cat-create");
    expect(published!.request_id).toBe("req-audit-cat-publish");
    // Exactly one row per action (no duplicates).
    expect(rows.filter((r) => r.action === "catalogue_entry.created")).toHaveLength(1);
    expect(rows.filter((r) => r.action === "catalogue_entry.published")).toHaveLength(1);
  });

  it("audits plan create, offering-attach, and publish as PLATFORM-GLOBAL rows", async () => {
    const { userId } = await provisionOrg();
    seq += 1;
    const entry = await catalogue.create(
      {
        publicAlias: `audit-plan-off-${seq}`,
        upstreamAgentId: `agent-plan-${seq}`,
        displayName: `Plan Offering ${seq}`,
      },
      userId,
      "req-audit-plan-off",
    );
    seq += 1;
    const plan = await plans.create(
      {
        key: `audit-plan-${seq}`,
        name: `Audit Plan ${seq}`,
        kind: "free_trial",
        requestQuota: 100,
        selfServiceEligible: true,
      },
      userId,
      "req-audit-plan-create",
    );
    await plans.attachCatalogueEntry(
      plan.id,
      entry.id,
      userId,
      "req-audit-plan-attach",
    );
    await plans.setPublished(plan.id, true, userId, "req-audit-plan-publish");

    const rows = await rowsForTarget(plan.id);
    const actions = rows.map((r) => r.action).sort();
    expect(actions).toEqual(
      [
        "plan.created",
        "plan.offering_attached",
        "plan.published",
      ].sort(),
    );
    for (const row of rows) {
      expect(row.organization_id).toBeNull();
      expect(row.actor_user_id).toBe(userId);
      expect(row.system_actor).toBeNull();
      expect(row.target_type).toBe("plan");
      expect(row.target_id).toBe(plan.id);
      expectSafeSummary(row.after_summary);
    }
  });

  it("audits a self-service claim ORG-SCOPED and an admin grant PLATFORM-GLOBAL naming the affected org", async () => {
    // Publish a self-service-eligible plan with an offering.
    const admin = await provisionOrg();
    seq += 1;
    const entry = await catalogue.create(
      {
        publicAlias: `audit-sub-off-${seq}`,
        upstreamAgentId: `agent-sub-${seq}`,
        displayName: `Sub Offering ${seq}`,
      },
      admin.userId,
      "req-audit-sub-off",
    );
    seq += 1;
    const plan = await plans.create(
      {
        key: `audit-sub-plan-${seq}`,
        name: `Audit Sub Plan ${seq}`,
        kind: "commercial_monthly",
        requestQuota: 50,
        selfServiceEligible: true,
        adminGrantable: true,
      },
      admin.userId,
      "req-audit-sub-plan",
    );
    await plans.attachCatalogueEntry(plan.id, entry.id, admin.userId, "req-attach");
    await plans.setEnabled(plan.id, true, admin.userId, "req-enable");
    await plans.setPublished(plan.id, true, admin.userId, "req-publish");

    // Self-service: the org owner claims for their own org → org-scoped audit.
    const claimer = await provisionOrg();
    const selfSub = await subscriptions.grantFromPlan(
      claimer.organizationId,
      plan.id,
      {
        actorUserId: claimer.userId,
        requestId: "req-self-claim",
        viaAdmin: false,
      },
    );
    const selfRows = await rowsForTarget(selfSub.id);
    expect(selfRows).toHaveLength(1);
    const selfRow = selfRows[0]!;
    expect(selfRow.action).toBe("subscription.self_claimed");
    expect(selfRow.organization_id).toBe(claimer.organizationId);
    expect(selfRow.actor_user_id).toBe(claimer.userId);
    expect(selfRow.system_actor).toBeNull();
    expectSafeSummary(selfRow.after_summary);

    // Admin grant: the admin is NOT a member of the grantee org → platform-global
    // (org NULL) naming the affected org in after_summary.
    const grantee = await provisionOrg();
    const adminSub = await subscriptions.grantFromPlan(
      grantee.organizationId,
      plan.id,
      { actorUserId: admin.userId, requestId: "req-admin-grant", viaAdmin: true },
    );
    const adminRows = await rowsForTarget(adminSub.id);
    const grantRow = adminRows.find(
      (r) => r.action === "subscription.admin_granted",
    );
    expect(grantRow).toBeDefined();
    expect(grantRow!.organization_id).toBeNull();
    expect(grantRow!.actor_user_id).toBe(admin.userId);
    expect(grantRow!.after_summary?.organizationId).toBe(grantee.organizationId);
    expectSafeSummary(grantRow!.after_summary);

    // Admin status change: platform-global, naming the affected org.
    await subscriptions.setStatus(adminSub.id, "suspended", {
      actorUserId: admin.userId,
      requestId: "req-admin-status",
    });
    const afterStatus = await rowsForTarget(adminSub.id);
    const statusRow = afterStatus.find(
      (r) => r.action === "subscription.status_changed",
    );
    expect(statusRow).toBeDefined();
    expect(statusRow!.organization_id).toBeNull();
    expect(statusRow!.actor_user_id).toBe(admin.userId);
    expect(statusRow!.after_summary?.organizationId).toBe(
      grantee.organizationId,
    );
    expect(statusRow!.after_summary?.status).toBe("suspended");
  });

  it("audits PAT mint then revoke ORG-SCOPED with NO token/secret/hash in the summary", async () => {
    const { userId, organizationId } = await provisionOrg();
    const { token, record } = await pats.mint({
      userId,
      organizationId,
      name: "audit-pat",
      requestId: "req-audit-mint",
    });
    // Sanity: the raw token itself never appears anywhere in the audit table.
    await pats.revoke(record.id, userId, "req-audit-revoke");

    const rows = await rowsForTarget(record.id);
    const byAction = new Map(rows.map((r) => [r.action, r]));
    const minted = byAction.get("pat.minted");
    const revoked = byAction.get("pat.revoked");
    expect(minted).toBeDefined();
    expect(revoked).toBeDefined();

    for (const row of [minted!, revoked!]) {
      // PAT lifecycle is org-scoped: the owner acting within their own org.
      expect(row.organization_id).toBe(organizationId);
      expect(row.actor_user_id).toBe(userId);
      expect(row.system_actor).toBeNull();
      expect(row.target_type).toBe("personal_access_token");
      expect(row.target_id).toBe(record.id);
    }
    // The mint summary carries only safe metadata — never the secret/hash/token.
    const mintKeys = Object.keys(minted!.after_summary ?? {});
    for (const key of mintKeys) {
      expect(key).not.toMatch(/secret|hash|digest|token/i);
    }
    expectSafeSummary(minted!.after_summary);
    expectSafeSummary(revoked!.before_summary);
    expectSafeSummary(revoked!.after_summary);
    // The raw token value must not appear in ANY column of the mint/revoke rows.
    const dump = await pool.query<{ row_text: string }>(
      "SELECT audit_events::text AS row_text FROM audit_events WHERE target_id=$1",
      [record.id],
    );
    for (const r of dump.rows) expect(r.row_text).not.toContain(token);
  });
});
