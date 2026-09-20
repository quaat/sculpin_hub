import { createHmac } from "node:crypto";
import { parsePatToken } from "@sculpin/domain";
import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  PostgresPatService,
  hashPatSecret,
  verifyPatSecretHash,
  type PatKeyring,
} from "./pat.js";

const KEY = "x".repeat(48);
const KEYRING: PatKeyring = {
  currentVersion: 1,
  keys: new Map([[1, KEY]]),
};

/**
 * A minimal fake pg Pool that dispatches on the SQL text. `pool.query` handles
 * the authenticate/revoke/list paths; `pool.connect()` returns a client that
 * mint() drives through BEGIN/INSERT/SELECT/COMMIT. Records every call so tests
 * can assert exactly what is (and is NOT) sent to the database.
 */
function fakePool(handlers: {
  onInsert?: (params?: unknown[]) => { rows: unknown[]; rowCount?: number };
  onScopeInsert?: (params?: unknown[]) => { rows: unknown[]; rowCount: number };
  onSelect?: (params?: unknown[]) => { rows: unknown[] };
  onUpdate?: (params?: unknown[]) => { rows: unknown[] };
}): {
  pool: Pool;
  calls: { sql: string; params: unknown[] }[];
  clientReleased: () => boolean;
} {
  const calls: { sql: string; params: unknown[] }[] = [];
  let released = false;
  const run = (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (/^\s*INSERT INTO personal_access_token_scopes/i.test(sql))
      return Promise.resolve(
        handlers.onScopeInsert?.(params) ?? { rows: [], rowCount: 0 },
      );
    if (/^\s*INSERT/i.test(sql))
      return Promise.resolve(handlers.onInsert?.(params) ?? { rows: [] });
    if (/^\s*UPDATE/i.test(sql))
      return Promise.resolve(handlers.onUpdate?.(params) ?? { rows: [] });
    if (/^\s*SELECT/i.test(sql))
      return Promise.resolve(handlers.onSelect?.(params) ?? { rows: [] });
    // BEGIN / COMMIT / ROLLBACK
    return Promise.resolve({ rows: [] });
  };
  const query = vi.fn(run);
  const client = {
    query: vi.fn(run),
    release: vi.fn(() => {
      released = true;
    }),
  } as unknown as PoolClient;
  const connect = vi.fn(() => Promise.resolve(client));
  return {
    pool: { query, connect } as unknown as Pool,
    calls,
    clientReleased: () => released,
  };
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

describe("PostgresPatService keyring validation", () => {
  it("rejects a keyring whose current version has no key", () => {
    expect(
      () =>
        new PostgresPatService({} as Pool, {
          currentVersion: 2,
          keys: new Map([[1, KEY]]),
        }),
    ).toThrow("current version");
  });

  it("rejects any key shorter than 32 chars", () => {
    expect(
      () =>
        new PostgresPatService({} as Pool, {
          currentVersion: 1,
          keys: new Map([[1, "short"]]),
        }),
    ).toThrow("at least 32 characters");
  });

  it("rejects non-positive versions", () => {
    expect(
      () =>
        new PostgresPatService({} as Pool, {
          currentVersion: 1,
          keys: new Map([
            [1, KEY],
            [0, "y".repeat(48)],
          ]),
        }),
    ).toThrow("positive integers");
  });
});

describe("PostgresPatService.mint", () => {
  function findingInsert() {
    return { rows: [{ id: "pat-1" }] };
  }
  function findingSelect() {
    return {
      rows: [
        {
          id: "pat-1",
          publicId: "A".repeat(22),
          userId: "u",
          organizationId: "o",
          name: "n",
          status: "active",
          createdAt: new Date(),
          lastUsedAt: null,
          expiresAt: null,
          scopes: [],
        },
      ],
    };
  }

  it("rejects an invalid name before touching the database", async () => {
    const { pool, calls } = fakePool({});
    const service = new PostgresPatService(pool, KEYRING);
    await expect(
      service.mint({ userId: "u", organizationId: "o", name: "  " }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("stores ONLY the HMAC digest and stamps the current key version", async () => {
    let insertedParams: unknown[] = [];
    const { pool } = fakePool({
      onInsert: (params) => {
        insertedParams = params ?? [];
        return findingInsert();
      },
      onSelect: findingSelect,
    });
    const service = new PostgresPatService(pool, KEYRING);
    const { token, record } = await service.mint({
      userId: "11111111-1111-1111-1111-111111111111",
      organizationId: "22222222-2222-2222-2222-222222222222",
      name: "My laptop",
    });

    const parsed = parsePatToken(token);
    expect(parsed).toBeDefined();
    const { publicId, secret } = parsed!;

    // INSERT params: [publicId, userId, orgId, name, secretHash, version, expiresAt]
    const storedHash = insertedParams[4] as string;
    const version = insertedParams[5] as number;
    expect(storedHash).toBe(hashPatSecret(secret, KEY));
    expect(version).toBe(1);
    expect(insertedParams).not.toContain(secret);
    expect(storedHash).not.toBe(secret);
    expect(parsePatToken(`sclp_pat_${publicId}_${storedHash}`)).toBeUndefined();
    expect(JSON.stringify(record)).not.toContain(secret);
    expect(JSON.stringify(record)).not.toContain(storedHash);
    expect(record.scopes).toEqual([]);
  });

  it("inserts immutable scope rows and rolls back on an unknown scope id", async () => {
    const scopeIds = [
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ];
    // Simulate only ONE of the two scopes existing: rowCount 1 !== 2 -> rollback.
    const { pool, calls, clientReleased } = fakePool({
      onInsert: findingInsert,
      onScopeInsert: () => ({ rows: [], rowCount: 1 }),
      onSelect: findingSelect,
    });
    const service = new PostgresPatService(pool, KEYRING);
    await expect(
      service.mint({
        userId: "u",
        organizationId: "o",
        name: "scoped",
        scopeCatalogueEntryIds: scopeIds,
      }),
    ).rejects.toThrow(/do not exist/i);
    // The transaction rolled back and the client was released.
    expect(calls.some((c) => /ROLLBACK/i.test(c.sql))).toBe(true);
    expect(calls.some((c) => /COMMIT/i.test(c.sql))).toBe(false);
    expect(clientReleased()).toBe(true);
  });

  it("rejects malformed scope ids before touching the database", async () => {
    const { pool, calls } = fakePool({});
    const service = new PostgresPatService(pool, KEYRING);
    await expect(
      service.mint({
        userId: "u",
        organizationId: "o",
        name: "bad-scope",
        scopeCatalogueEntryIds: ["not-a-uuid"],
      }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
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
        onInsert: () => ({ rows: [{ id: "pat-1" }] }),
        onSelect: () => {
          // The mint re-SELECT (by id) vs the authenticate lookup (by public id):
          // both return a usable shape here.
          return {
            rows: [
              {
                id: "pat-1",
                publicId,
                userId: "u",
                organizationId: "o",
                name: "n",
                status: "active",
                createdAt: new Date(),
                lastUsedAt: null,
                expiresAt: null,
                secretHash: hashPatSecret(secret, KEY),
                hashKeyVersion: 1,
                scopes: [],
              },
            ],
          };
        },
      });
      const service = new PostgresPatService(pool, KEYRING);
      const minted = await service.mint({
        userId: "u",
        organizationId: "o",
        name: "n",
      });
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

  function serviceThatFinds(
    row: { secret: string; hashKeyVersion?: number; scopes?: string[] },
    keyring: PatKeyring = KEYRING,
  ): {
    service: PostgresPatService;
    calls: { sql: string; params: unknown[] }[];
  } {
    const digestKey = keyring.keys.get(row.hashKeyVersion ?? 1) ?? KEY;
    const { pool, calls } = fakePool({
      onSelect: () => ({
        rows: [
          {
            id: "pat-1",
            userId: "user-1",
            organizationId: "org-1",
            secretHash: hashPatSecret(row.secret, digestKey),
            hashKeyVersion: row.hashKeyVersion ?? 1,
            scopes: row.scopes ?? [],
          },
        ],
      }),
      onUpdate: () => ({ rows: [] }),
    });
    return { service: new PostgresPatService(pool, keyring), calls };
  }

  it("resolves an identity WITH scopes and touches last_used", async () => {
    const { service, calls } = serviceThatFinds({
      secret,
      scopes: ["ce-1", "ce-2"],
    });
    const identity = await service.authenticate(goodToken);
    expect(identity).toEqual({
      patId: "pat-1",
      userId: "user-1",
      organizationId: "org-1",
      scopes: ["ce-1", "ce-2"],
    });
    expect(calls.map((c) => c.sql.trim().slice(0, 6))).toEqual([
      "SELECT",
      "UPDATE",
    ]);
  });

  it("resolves an UNSCOPED token with an empty scopes array", async () => {
    const { service } = serviceThatFinds({ secret, scopes: [] });
    const identity = await service.authenticate(goodToken);
    expect(identity?.scopes).toEqual([]);
  });

  it("verifies a token stamped under a RETIRED key version", async () => {
    // currentVersion=2 but the keyring still carries the v1 key; a v1 token
    // must still verify.
    const RETIRED = "r".repeat(48);
    const keyring: PatKeyring = {
      currentVersion: 2,
      keys: new Map([
        [1, RETIRED],
        [2, KEY],
      ]),
    };
    const { service } = serviceThatFinds(
      { secret, hashKeyVersion: 1 },
      keyring,
    );
    expect(await service.authenticate(goodToken)).toBeDefined();
  });

  it("fails opaquely when the stored key version is absent from the keyring", async () => {
    // Row claims version 9, which the keyring does not contain.
    const { pool, calls } = fakePool({
      onSelect: () => ({
        rows: [
          {
            id: "pat-1",
            userId: "user-1",
            organizationId: "org-1",
            secretHash: hashPatSecret(secret, KEY),
            hashKeyVersion: 9,
            scopes: [],
          },
        ],
      }),
    });
    const service = new PostgresPatService(pool, KEYRING);
    expect(await service.authenticate(goodToken)).toBeUndefined();
    // Looked up but never updated last_used.
    expect(calls.every((c) => !/^\s*UPDATE/i.test(c.sql))).toBe(true);
  });

  it("denies a wrong secret without updating last_used", async () => {
    const { service, calls } = serviceThatFinds({ secret: "z".repeat(43) });
    expect(await service.authenticate(goodToken)).toBeUndefined();
    expect(calls.every((c) => !/^\s*UPDATE/i.test(c.sql))).toBe(true);
  });

  it("denies a malformed token WITHOUT any database lookup", async () => {
    const { pool, calls } = fakePool({});
    const service = new PostgresPatService(pool, KEYRING);
    expect(await service.authenticate("not-a-pat")).toBeUndefined();
    expect(await service.authenticate("")).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("denies when no active row matches (unknown/revoked/expired/inactive)", async () => {
    const { pool, calls } = fakePool({ onSelect: () => ({ rows: [] }) });
    const service = new PostgresPatService(pool, KEYRING);
    expect(await service.authenticate(goodToken)).toBeUndefined();
    expect(calls.map((c) => c.sql.trim().slice(0, 6))).toEqual(["SELECT"]);
  });
});
