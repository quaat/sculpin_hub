import { parsePatToken } from "@sculpin/domain";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PostgresPatService,
  hashPatSecret,
  type PatKeyring,
} from "./pat.js";
import { PostgresCatalogueRepository } from "./catalogue.js";
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
const RETIRED_KEY = "integration-pat-hash-secret-RETIRED-v1-0123456789";
const KEYRING: PatKeyring = { currentVersion: 1, keys: new Map([[1, KEY]]) };

suite("personal access token service", () => {
  let pool: pg.Pool;
  let service: PostgresPatService;
  let tenant: PostgresPersonalTenantTransaction;
  let catalogue: PostgresCatalogueRepository;
  let seq = 0;

  async function createCatalogueEntry(ownerUserId: string): Promise<string> {
    seq += 1;
    const entry = await catalogue.create(
      {
        publicAlias: `pat-scope-${seq}`,
        upstreamAgentId: `agent-${seq}`,
        displayName: `Scope ${seq}`,
      },
      ownerUserId,
      `req-pat-scope-${seq}`,
    );
    return entry.id;
  }

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
    service = new PostgresPatService(pool, KEYRING);
    tenant = new PostgresPersonalTenantTransaction(pool);
    catalogue = new PostgresCatalogueRepository(pool);
  });
  afterAll(() => pool?.end());

  it("stores only the keyed digest — the DB holds no usable credential", async () => {
    const { userId, organizationId } = await provisionUser();
    const { token, record } = await service.mint({
      userId,
      organizationId,
      requestId: "req-mint",
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
      requestId: "req-mint",
      name: "primary",
    });
    const identity = await service.authenticate(token);
    expect(identity).toEqual({
      patId: record.id,
      userId,
      organizationId,
      scopes: [],
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
      requestId: "req-mint",
      name: "to-revoke",
    });
    expect(await service.authenticate(token)).toBeDefined();
    // Another user cannot revoke it.
    const other = await provisionUser();
    expect(
      await service.revoke(record.id, other.userId, "req-revoke"),
    ).toBeUndefined();
    expect(await service.authenticate(token)).toBeDefined();
    // The owner can, and a second revoke is a no-op.
    expect(
      (await service.revoke(record.id, userId, "req-revoke"))?.status,
    ).toBe("revoked");
    expect(
      await service.revoke(record.id, userId, "req-revoke"),
    ).toBeUndefined();
    expect(await service.authenticate(token)).toBeUndefined();
  });

  it("stops authenticating once expired", async () => {
    const { userId, organizationId } = await provisionUser();
    const { token, record } = await service.mint({
      userId,
      organizationId,
      requestId: "req-mint",
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
      requestId: "req-mint",
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
    await service.mint({
      userId,
      organizationId,
      requestId: "req-mint",
      name: "one",
    });
    await service.mint({
      userId,
      organizationId,
      requestId: "req-mint",
      name: "two",
    });
    const list = await service.listForUser(userId);
    expect(list).toHaveLength(2);
    expect(JSON.stringify(list)).not.toMatch(/secret|hash/i);
  });

  it("persists exactly the requested immutable scope rows and returns them on auth", async () => {
    const { userId, organizationId } = await provisionUser();
    const ce1 = await createCatalogueEntry(userId);
    const ce2 = await createCatalogueEntry(userId);
    const { token, record } = await service.mint({
      userId,
      organizationId,
      requestId: "req-mint",
      name: "scoped",
      scopeCatalogueEntryIds: [ce2, ce1],
    });
    const expected = [ce1, ce2].sort();
    expect([...record.scopes].sort()).toEqual(expected);

    // The scope rows are exactly the two requested entries.
    const { rows } = await pool.query<{ catalogue_entry_id: string }>(
      "SELECT catalogue_entry_id FROM personal_access_token_scopes WHERE pat_id=$1 ORDER BY catalogue_entry_id",
      [record.id],
    );
    expect(rows.map((r) => r.catalogue_entry_id).sort()).toEqual(expected);

    const identity = await service.authenticate(token);
    expect([...(identity?.scopes ?? [])].sort()).toEqual(expected);
  });

  it("authenticates an UNSCOPED token with an empty scopes array", async () => {
    const { userId, organizationId } = await provisionUser();
    const { token } = await service.mint({
      userId,
      organizationId,
      requestId: "req-mint",
      name: "unscoped",
    });
    const identity = await service.authenticate(token);
    expect(identity?.scopes).toEqual([]);
  });

  it("rejects a mint naming an unknown catalogue entry and persists nothing (rollback)", async () => {
    const { userId, organizationId } = await provisionUser();
    const real = await createCatalogueEntry(userId);
    const bogus = "00000000-0000-4000-8000-00000000dead";
    const before = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM personal_access_tokens WHERE user_id=$1",
      [userId],
    );
    await expect(
      service.mint({
        userId,
        organizationId,
        requestId: "req-mint",
        name: "bad-scope",
        scopeCatalogueEntryIds: [real, bogus],
      }),
    ).rejects.toThrow(/do not exist/i);
    // No PAT row and no scope rows were left behind.
    const after = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM personal_access_tokens WHERE user_id=$1",
      [userId],
    );
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
    const scopeRows = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM personal_access_token_scopes s JOIN personal_access_tokens p ON p.id=s.pat_id WHERE p.user_id=$1",
      [userId],
    );
    expect(scopeRows.rows[0]?.n).toBe("0");
  });

  it("still verifies a token minted under a RETIRED key version after rotation", async () => {
    // Mint under a keyring whose currentVersion=1.
    const v1Service = new PostgresPatService(pool, {
      currentVersion: 1,
      keys: new Map([[1, KEY]]),
    });
    const { userId, organizationId } = await provisionUser();
    const { token } = await v1Service.mint({
      userId,
      organizationId,
      requestId: "req-mint",
      name: "pre-rotation",
    });
    // Rotate: currentVersion=2 with a NEW current key, but v1 remains present.
    const rotated = new PostgresPatService(pool, {
      currentVersion: 2,
      keys: new Map([
        [1, KEY],
        [2, RETIRED_KEY],
      ]),
    });
    expect(await rotated.authenticate(token)).toBeDefined();
    // A NEW mint under the rotated keyring stamps version 2.
    const fresh = await rotated.mint({
      userId,
      organizationId,
      requestId: "req-mint",
      name: "post-rotation",
    });
    const { rows } = await pool.query<{ hash_key_version: number }>(
      "SELECT hash_key_version FROM personal_access_tokens WHERE id=$1",
      [fresh.record.id],
    );
    expect(rows[0]?.hash_key_version).toBe(2);
    expect(await rotated.authenticate(fresh.token)).toBeDefined();
  });

  it("fails opaquely when the stored key version is absent from the keyring", async () => {
    const { userId, organizationId } = await provisionUser();
    const { token, record } = await service.mint({
      userId,
      organizationId,
      requestId: "req-mint",
      name: "orphaned-version",
    });
    expect(await service.authenticate(token)).toBeDefined();
    // Simulate a version the running keyring no longer knows.
    await pool.query(
      "UPDATE personal_access_tokens SET hash_key_version=99 WHERE id=$1",
      [record.id],
    );
    expect(await service.authenticate(token)).toBeUndefined();
  });

  it("rejects a wrong secret for a real public id", async () => {
    const { userId, organizationId } = await provisionUser();
    const { token } = await service.mint({
      userId,
      organizationId,
      requestId: "req-mint",
      name: "wrong-secret",
    });
    const parsed = parsePatToken(token)!;
    const tampered = `sclp_pat_${parsed.publicId}_${"z".repeat(43)}`;
    expect(await service.authenticate(tampered)).toBeUndefined();
  });
});
