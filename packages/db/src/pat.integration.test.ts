import { parsePatToken } from "@sculpin/domain";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresPatService, hashPatSecret } from "./pat.js";
import { PostgresPersonalTenantTransaction } from "./tenant.js";

/**
 * M5 PAT invariants against a real (ephemeral) PostgreSQL (CLAUDE.md rule 2):
 *  - mint persists ONLY the HMAC-SHA-256 keyed digest; the raw secret never
 *    appears in any column, so a DB dump yields no usable bearer credential;
 *  - the stored digest itself cannot be replayed as a token;
 *  - authenticate re-derives an active user/org/membership and verifies the
 *    secret in constant time;
 *  - revocation and expiry immediately stop authentication;
 *  - a deactivated user / suspended org stops authentication (fail closed).
 */
const enabled = process.env.RUN_DATABASE_INTEGRATION === "true";
const suite = enabled ? describe : describe.skip;

const KEY = "integration-pat-hash-secret-0123456789abcdef";

suite("personal access token service", () => {
  let pool: pg.Pool;
  let service: PostgresPatService;
  let tenant: PostgresPersonalTenantTransaction;
  let seq = 0;

  async function provisionUser(): Promise<{
    userId: string;
    organizationId: string;
  }> {
    seq += 1;
    return tenant.create({
      normalizedEmail: `pat-${seq}@example.com`,
      displayName: `Pat Tenant ${seq}`,
      locale: "en",
      organizationSlug: `pat-tenant-${seq}`,
      requestId: `pat-tenant-${seq}`,
    });
  }

  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
    service = new PostgresPatService(pool, KEY);
    tenant = new PostgresPersonalTenantTransaction(pool);
  });
  afterAll(() => pool?.end());

  it("stores only the keyed digest — the DB holds no usable credential", async () => {
    const { userId, organizationId } = await provisionUser();
    const { token, record } = await service.mint({
      userId,
      organizationId,
      name: "CI laptop",
    });
    const parsed = parsePatToken(token);
    expect(parsed).toBeDefined();
    const { publicId, secret } = parsed!;

    // Inspect the raw row: no column contains the plaintext secret, and the
    // stored secret_hash equals HMAC(secret, KEY).
    const { rows } = await pool.query<{
      secret_hash: string;
      row_text: string;
    }>(
      `SELECT secret_hash, personal_access_tokens::text AS row_text
       FROM personal_access_tokens WHERE id=$1`,
      [record.id],
    );
    const row = rows[0]!;
    expect(row.secret_hash).toBe(hashPatSecret(secret, KEY));
    expect(row.row_text).not.toContain(secret);

    // The stored digest, if leaked, is not a valid token and cannot authenticate.
    expect(
      await service.authenticate(`sclp_pat_${publicId}_${row.secret_hash}`),
    ).toBeUndefined();
  });

  it("authenticates a valid token and touches last_used", async () => {
    const { userId, organizationId } = await provisionUser();
    const { token, record } = await service.mint({
      userId,
      organizationId,
      name: "primary",
    });
    const identity = await service.authenticate(token);
    expect(identity).toEqual({
      patId: record.id,
      userId,
      organizationId,
    });
    const { rows } = await pool.query<{ last_used_at: Date | null }>(
      "SELECT last_used_at FROM personal_access_tokens WHERE id=$1",
      [record.id],
    );
    expect(rows[0]?.last_used_at).toBeInstanceOf(Date);
  });

  it("stops authenticating after revocation (owner-scoped, idempotent)", async () => {
    const { userId, organizationId } = await provisionUser();
    const { token, record } = await service.mint({
      userId,
      organizationId,
      name: "to-revoke",
    });
    expect(await service.authenticate(token)).toBeDefined();
    // Another user cannot revoke it.
    const other = await provisionUser();
    expect(await service.revoke(record.id, other.userId)).toBeUndefined();
    expect(await service.authenticate(token)).toBeDefined();
    // The owner can, and a second revoke is a no-op.
    expect((await service.revoke(record.id, userId))?.status).toBe("revoked");
    expect(await service.revoke(record.id, userId)).toBeUndefined();
    expect(await service.authenticate(token)).toBeUndefined();
  });

  it("stops authenticating once expired", async () => {
    const { userId, organizationId } = await provisionUser();
    const { token, record } = await service.mint({
      userId,
      organizationId,
      name: "expiring",
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await service.authenticate(token)).toBeDefined();
    await pool.query(
      "UPDATE personal_access_tokens SET expires_at = now() - interval '1 second' WHERE id=$1",
      [record.id],
    );
    expect(await service.authenticate(token)).toBeUndefined();
  });

  it("fails closed when the owning user or org is not active", async () => {
    const { userId, organizationId } = await provisionUser();
    const { token } = await service.mint({
      userId,
      organizationId,
      name: "gated",
    });
    await pool.query(
      "UPDATE users SET status='deactivated', deactivated_at=now() WHERE id=$1",
      [userId],
    );
    expect(await service.authenticate(token)).toBeUndefined();
    await pool.query(
      "UPDATE users SET status='active', deactivated_at=NULL WHERE id=$1",
      [userId],
    );
    expect(await service.authenticate(token)).toBeDefined();
    await pool.query(
      "UPDATE organizations SET status='suspended' WHERE id=$1",
      [organizationId],
    );
    expect(await service.authenticate(token)).toBeUndefined();
  });

  it("lists a user's tokens without exposing secrets", async () => {
    const { userId, organizationId } = await provisionUser();
    await service.mint({ userId, organizationId, name: "one" });
    await service.mint({ userId, organizationId, name: "two" });
    const list = await service.listForUser(userId);
    expect(list).toHaveLength(2);
    expect(JSON.stringify(list)).not.toMatch(/secret|hash/i);
  });
});
