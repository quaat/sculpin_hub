import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresPersonalTenantTransaction } from "./tenant.js";

/**
 * M-1 / ADR 006 identity invariants against a real (ephemeral) PostgreSQL:
 *  - the pruned OAuth token columns do NOT exist on `external_identities`
 *    (a DB leak yields no usable provider credentials — the control is the
 *    absence of the data, not encryption-at-rest);
 *  - every `users` row owns a personal organization (no orphan user), and the
 *    invariant query actually DETECTS an orphan when one is planted.
 */
const enabled = process.env.RUN_DATABASE_INTEGRATION === "true";
const suite = enabled ? describe : describe.skip;

const PRUNED_TOKEN_COLUMNS = [
  "access_token",
  "refresh_token",
  "id_token",
  "access_token_expires_at",
  "refresh_token_expires_at",
  "scope",
  "password",
];

const orphanUserQuery = `
  SELECT u.id
  FROM users u
  LEFT JOIN organizations o
    ON o.type = 'personal' AND o.personal_owner_user_id = u.id
  WHERE o.id IS NULL
`;

suite("identity persistence invariants", () => {
  let pool: pg.Pool;
  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  });
  afterAll(() => pool?.end());

  it("has dropped every OAuth token/credential column from external_identities", async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'external_identities' AND column_name = ANY($1)`,
      [PRUNED_TOKEN_COLUMNS],
    );
    expect(rows.map((r) => r.column_name)).toEqual([]);
  });

  it("keeps the identity/audit columns the Hub actually uses", async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'external_identities'`,
    );
    const columns = new Set(rows.map((r) => r.column_name));
    for (const kept of [
      "provider",
      "provider_subject",
      "provider_email",
      "email_verified",
    ]) {
      expect(columns.has(kept)).toBe(true);
    }
  });

  it("leaves no orphan user after atomic provisioning", async () => {
    const tx = new PostgresPersonalTenantTransaction(pool);
    const result = await tx.create({
      normalizedEmail: "no-orphan@example.com",
      displayName: "No Orphan",
      locale: "en",
      organizationSlug: "no-orphan-org",
      requestId: "no-orphan",
    });
    const { rows } = await pool.query<{ id: string }>(
      `${orphanUserQuery} AND u.id = $1`,
      [result.userId],
    );
    expect(rows).toEqual([]);
  });

  it("detects a planted orphan user (proves the invariant query works)", async () => {
    // Insert a user directly, bypassing provisioning, then roll back so the
    // suite leaves no orphan behind. The query must flag it while it exists.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO users (normalized_email, display_name, locale)
         VALUES ('planted-orphan@example.com', 'Planted', 'en') RETURNING id`,
      );
      const plantedId = inserted.rows[0]!.id;
      const { rows } = await client.query<{ id: string }>(
        `${orphanUserQuery} AND u.id = $1`,
        [plantedId],
      );
      expect(rows.map((r) => r.id)).toEqual([plantedId]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
