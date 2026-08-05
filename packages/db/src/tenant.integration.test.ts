import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PostgresIdentityRepository,
  PostgresMembershipRepository,
  PostgresPersonalTenantTransaction,
} from "./tenant.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION === "true";
const suite = enabled ? describe : describe.skip;
const command = (suffix: string, identity = true) => ({
  normalizedEmail: `tenant-${suffix}@example.com`,
  displayName: `Tenant ${suffix}`,
  locale: "en",
  organizationSlug: `tenant-${suffix}`,
  requestId: `tenant-${suffix}`,
  ...(identity
    ? {
        identity: {
          provider: "google",
          providerSubject: `subject-${suffix}`,
          providerEmail: `tenant-${suffix}@example.com`,
          emailVerified: true,
          metadata: {
            schemaVersion: 1 as const,
            issuer: "google",
            tenant: "test",
          },
        },
      }
    : {}),
});

suite("personal tenant transaction", () => {
  let pool: pg.Pool;
  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
  });
  afterAll(() => pool?.end());

  it("commits user, identity, personal owner, membership, audit, and outbox atomically", async () => {
    const tx = new PostgresPersonalTenantTransaction(pool);
    const result = await tx.create(command("success-with-identity"));
    const rows = await pool.query(
      "SELECT u.id AS user_id, e.provider_subject, o.personal_owner_user_id, m.role, a.action, ob.event_type, ob.payload FROM users u JOIN external_identities e ON e.user_id=u.id JOIN organizations o ON o.personal_owner_user_id=u.id JOIN organization_memberships m ON m.organization_id=o.id AND m.user_id=u.id JOIN audit_events a ON a.organization_id=o.id JOIN outbox_events ob ON ob.organization_id=o.id WHERE u.id=$1",
      [result.userId],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]).toMatchObject({
      user_id: result.userId,
      provider_subject: "subject-success-with-identity",
      personal_owner_user_id: result.userId,
      role: "owner",
      action: "personal_organization.created",
      event_type: "personal_organization.created",
    });
    expect(rows.rows[0].payload).toEqual({
      organizationId: result.organizationId,
      userId: result.userId,
    });
  });

  it("creates a tenant without an external identity", async () => {
    const tx = new PostgresPersonalTenantTransaction(pool);
    const result = await tx.create(command("success-without-identity", false));
    const identity = await pool.query(
      "SELECT 1 FROM external_identities WHERE user_id=$1",
      [result.userId],
    );
    const membership = await new PostgresMembershipRepository(pool).findUser(
      {
        organizationId: result.organizationId,
        actorUserId: result.userId,
        requestId: "tenant-check",
      },
      result.userId,
    );
    expect(identity.rowCount).toBe(0);
    expect(membership).toEqual({ userId: result.userId, role: "owner" });
  });

  it("maps duplicate provider subject and slug conflicts", async () => {
    const tx = new PostgresPersonalTenantTransaction(pool);
    await tx.create(command("duplicate-identity"));
    await expect(
      tx.create({
        ...command("duplicate-identity-other"),
        identity: command("duplicate-identity").identity,
      }),
    ).rejects.toMatchObject({ code: "identity_conflict" });
    await expect(
      tx.create({
        ...command("duplicate-identity", false),
        normalizedEmail: "tenant-duplicate-slug@example.com",
      }),
    ).rejects.toMatchObject({ code: "organization_slug_conflict" });
  });

  it("keeps global identity lookup separate from tenant-scoped membership reads", async () => {
    const tx = new PostgresPersonalTenantTransaction(pool);
    const tenantA = await tx.create(command("tenant-a"));
    const tenantB = await tx.create(command("tenant-b"));
    const memberships = new PostgresMembershipRepository(pool);
    await expect(
      memberships.findUser(
        {
          organizationId: tenantA.organizationId,
          actorUserId: tenantA.userId,
          requestId: "cross",
        },
        tenantB.userId,
      ),
    ).resolves.toBeUndefined();
    await expect(
      new PostgresIdentityRepository(pool).findUserId(
        "google",
        "subject-tenant-b",
      ),
    ).resolves.toBe(tenantB.userId);
  });

  it("rolls back when a database trigger fails before outbox commit", async () => {
    const triggerName = "tenant_integration_fail_audit";
    await pool.query(
      `CREATE OR REPLACE FUNCTION ${triggerName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.request_id = 'tenant-fail-audit' THEN RAISE EXCEPTION 'tenant integration audit failure'; END IF; RETURN NEW; END; $$`,
    );
    await pool.query(
      `CREATE TRIGGER ${triggerName} BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION ${triggerName}()`,
    );
    try {
      const tx = new PostgresPersonalTenantTransaction(pool);
      await expect(tx.create(command("fail-audit"))).rejects.toThrow(
        "tenant integration audit failure",
      );
      const persisted = await pool.query(
        "SELECT 1 FROM users WHERE normalized_email='tenant-fail-audit@example.com'",
      );
      expect(persisted.rowCount).toBe(0);
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON audit_events`);
      await pool.query(`DROP FUNCTION IF EXISTS ${triggerName}()`);
    }
  });
});
