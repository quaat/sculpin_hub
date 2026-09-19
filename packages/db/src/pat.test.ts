import { createHmac } from "node:crypto";
import { parsePatToken } from "@sculpin/domain";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  PostgresPatService,
  hashPatSecret,
  verifyPatSecretHash,
} from "./pat.js";

const KEY = "x".repeat(48);

/**
 * A minimal fake pg Pool that dispatches on the SQL text. Records every call so
 * tests can assert exactly what is (and is NOT) sent to the database.
 */
function fakePool(handlers: {
  onInsert?: (params: unknown[]) => { rows: unknown[] };
  onSelect?: (params: unknown[]) => { rows: unknown[] };
  onUpdate?: (params: unknown[]) => { rows: unknown[] };
}): { pool: Pool; calls: { sql: string; params: unknown[] }[] } {
  const calls: { sql: string; params: unknown[] }[] = [];
  const query = vi.fn((sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (/^\s*INSERT/i.test(sql))
      return Promise.resolve(handlers.onInsert?.(params) ?? { rows: [] });
    if (/^\s*UPDATE/i.test(sql))
      return Promise.resolve(handlers.onUpdate?.(params) ?? { rows: [] });
    if (/^\s*SELECT/i.test(sql))
      return Promise.resolve(handlers.onSelect?.(params) ?? { rows: [] });
    return Promise.resolve({ rows: [] });
  });
  return { pool: { query } as unknown as Pool, calls };
}

describe("PAT keyed hashing", () => {
  it("is a deterministic HMAC-SHA-256 base64 of the secret", () => {
    const expected = createHmac("sha256", KEY)
      .update("s3cret", "utf8")
      .digest("base64");
    expect(hashPatSecret("s3cret", KEY)).toBe(expected);
    expect(hashPatSecret("s3cret", KEY)).toBe(hashPatSecret("s3cret", KEY));
  });

  it("differs by secret and by key (keyed, not a bare hash)", () => {
    expect(hashPatSecret("a", KEY)).not.toBe(hashPatSecret("b", KEY));
    expect(hashPatSecret("a", KEY)).not.toBe(hashPatSecret("a", "y".repeat(48)));
  });

  it("verifies in constant time: true only for the exact secret+key", () => {
    const stored = hashPatSecret("right", KEY);
    expect(verifyPatSecretHash("right", KEY, stored)).toBe(true);
    expect(verifyPatSecretHash("wrong", KEY, stored)).toBe(false);
    expect(verifyPatSecretHash("right", "z".repeat(48), stored)).toBe(false);
  });
});

describe("PostgresPatService.mint", () => {
  it("rejects a hash key shorter than 32 chars", () => {
    expect(() => new PostgresPatService({} as Pool, "short")).toThrow(
      "at least 32 characters",
    );
  });

  it("rejects an invalid name before touching the database", async () => {
    const { pool, calls } = fakePool({});
    const service = new PostgresPatService(pool, KEY);
    await expect(
      service.mint({ userId: "u", organizationId: "o", name: "  " }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("stores ONLY the HMAC digest of the secret — never the raw secret", async () => {
    let insertedParams: unknown[] = [];
    const { pool } = fakePool({
      onInsert: (params) => {
        insertedParams = params;
        return {
          rows: [
            {
              id: "pat-1",
              publicId: params[0],
              userId: params[1],
              organizationId: params[2],
              name: params[3],
              status: "active",
              createdAt: new Date(),
              lastUsedAt: null,
              expiresAt: null,
            },
          ],
        };
      },
    });
    const service = new PostgresPatService(pool, KEY);
    const { token, record } = await service.mint({
      userId: "11111111-1111-1111-1111-111111111111",
      organizationId: "22222222-2222-2222-2222-222222222222",
      name: "My laptop",
    });

    const parsed = parsePatToken(token);
    expect(parsed).toBeDefined();
    const { publicId, secret } = parsed!;

    // INSERT params: [publicId, userId, orgId, name, secretHash, expiresAt]
    const storedHash = insertedParams[4] as string;
    // The persisted column is the keyed digest, NOT the raw secret.
    expect(storedHash).toBe(hashPatSecret(secret, KEY));
    expect(insertedParams).not.toContain(secret);
    expect(storedHash).not.toBe(secret);
    // The stored digest, if leaked, is not itself a valid PAT secret (not base62
    // 43 chars), so a DB dump cannot be replayed as a bearer credential.
    expect(parsePatToken(`sclp_pat_${publicId}_${storedHash}`)).toBeUndefined();
    // The returned record never carries the secret or the digest.
    expect(JSON.stringify(record)).not.toContain(secret);
    expect(JSON.stringify(record)).not.toContain(storedHash);
  });
});

describe("PAT logging hygiene (CLAUDE.md rule 5)", () => {
  it("never passes the raw token or secret to any console method", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map(
      (m) => vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    try {
      const publicId = "A".repeat(22);
      const secret = "b".repeat(43);
      const token = `sclp_pat_${publicId}_${secret}`;
      const { pool } = fakePool({
        onInsert: (params) => ({
          rows: [
            {
              id: "pat-1",
              publicId: params[0],
              userId: params[1],
              organizationId: params[2],
              name: params[3],
              status: "active",
              createdAt: new Date(),
              lastUsedAt: null,
              expiresAt: null,
            },
          ],
        }),
        onSelect: () => ({
          rows: [
            {
              id: "pat-1",
              userId: "u",
              organizationId: "o",
              secretHash: hashPatSecret(secret, KEY),
            },
          ],
        }),
      });
      const service = new PostgresPatService(pool, KEY);
      const minted = await service.mint({ userId: "u", organizationId: "o", name: "n" });
      await service.authenticate(minted.token);
      await service.authenticate(token);
      const logged = spies.flatMap((s) =>
        s.mock.calls.flat().map((a) => String(a)),
      );
      for (const line of logged) {
        expect(line).not.toContain(secret);
        expect(line).not.toContain(minted.token);
        expect(line).not.toContain(token);
      }
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});

describe("PostgresPatService.authenticate", () => {
  const publicId = "A".repeat(22);
  const secret = "b".repeat(43);
  const goodToken = `sclp_pat_${publicId}_${secret}`;

  function serviceThatFinds(row: {
    secret: string;
  }): { service: PostgresPatService; calls: { sql: string; params: unknown[] }[] } {
    const { pool, calls } = fakePool({
      onSelect: () => ({
        rows: [
          {
            id: "pat-1",
            userId: "user-1",
            organizationId: "org-1",
            secretHash: hashPatSecret(row.secret, KEY),
          },
        ],
      }),
      onUpdate: () => ({ rows: [] }),
    });
    return { service: new PostgresPatService(pool, KEY), calls };
  }

  it("resolves an identity and touches last_used on the happy path", async () => {
    const { service, calls } = serviceThatFinds({ secret });
    const identity = await service.authenticate(goodToken);
    expect(identity).toEqual({
      patId: "pat-1",
      userId: "user-1",
      organizationId: "org-1",
    });
    // A SELECT (lookup) then an UPDATE (last_used) — nothing else.
    expect(calls.map((c) => c.sql.trim().slice(0, 6))).toEqual([
      "SELECT",
      "UPDATE",
    ]);
  });

  it("denies a wrong secret without updating last_used", async () => {
    const { service, calls } = serviceThatFinds({ secret: "z".repeat(43) });
    expect(await service.authenticate(goodToken)).toBeUndefined();
    expect(calls.every((c) => !/^\s*UPDATE/i.test(c.sql))).toBe(true);
  });

  it("denies a malformed token WITHOUT any database lookup", async () => {
    const { pool, calls } = fakePool({});
    const service = new PostgresPatService(pool, KEY);
    expect(await service.authenticate("not-a-pat")).toBeUndefined();
    expect(await service.authenticate("")).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("denies when no active row matches (unknown/revoked/expired/inactive)", async () => {
    const { pool, calls } = fakePool({ onSelect: () => ({ rows: [] }) });
    const service = new PostgresPatService(pool, KEY);
    expect(await service.authenticate(goodToken)).toBeUndefined();
    // Looked up, but never updated last_used.
    expect(calls.map((c) => c.sql.trim().slice(0, 6))).toEqual(["SELECT"]);
  });
});
