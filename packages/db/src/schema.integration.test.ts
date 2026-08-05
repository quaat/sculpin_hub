import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = process.env.RUN_DATABASE_INTEGRATION === "true";
const suite = enabled ? describe : describe.skip;
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;

async function expectPgError(
  action: () => Promise<unknown>,
  expected: { code?: string; constraint?: string; message?: RegExp },
) {
  try {
    await action();
  } catch (error) {
    const pgError = error as {
      code?: string;
      constraint?: string;
      message?: string;
    };
    if (expected.code) expect(pgError.code).toBe(expected.code);
    if (expected.constraint)
      expect(pgError.constraint).toBe(expected.constraint);
    if (expected.message) expect(pgError.message).toMatch(expected.message);
    return;
  }
  throw new Error("Expected PostgreSQL error.");
}

suite("schema invariants", () => {
  let client: pg.Client;
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
    client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
  });
  afterAll(async () => client?.end());

  it("rejects audit mutations and invalid actors while accepting system actors", async () => {
    const user = uuid(101);
    const outsider = uuid(102);
    const org = uuid(201);
    await client.query(
      "INSERT INTO users (id, normalized_email, display_name, locale) VALUES ($1,'schema-owner@example.com','Owner','en'),($2,'schema-outsider@example.com','Outsider','en')",
      [user, outsider],
    );
    await client.query(
      "INSERT INTO organizations (id, slug, type, personal_owner_user_id) VALUES ($1,'schema-owner','personal',$2)",
      [org, user],
    );
    await client.query(
      "INSERT INTO organization_memberships (organization_id, user_id, role) VALUES ($1,$2,'owner')",
      [org, user],
    );
    await client.query(
      "INSERT INTO audit_events (organization_id, system_actor, action, target_type, target_id, request_id, occurred_at) VALUES ($1,'system','schema.system','organization',$1,'schema-system',now())",
      [org],
    );
    await client.query(
      "INSERT INTO audit_events (organization_id, actor_user_id, action, target_type, target_id, request_id, occurred_at) VALUES ($1,$2,'schema.actor','organization',$1,'schema-actor',now())",
      [org, user],
    );
    await expectPgError(
      () =>
        client.query(
          "UPDATE audit_events SET request_id='changed' WHERE organization_id=$1",
          [org],
        ),
      { code: "P0001", message: /append-only/ },
    );
    await expectPgError(
      () =>
        client.query("DELETE FROM audit_events WHERE organization_id=$1", [
          org,
        ]),
      { code: "P0001", message: /append-only/ },
    );
    await expectPgError(
      () =>
        client.query(
          "INSERT INTO audit_events (organization_id, actor_user_id, action, target_type, target_id, request_id, occurred_at) VALUES ($1,$2,'schema.bad_actor','organization',$1,'schema-bad',now())",
          [org, outsider],
        ),
      {
        code: "23503",
        constraint: "audit_events_organization_id_actor_user_id_fkey",
      },
    );
  });

  it("enforces metadata and personal-owner invariants", async () => {
    const user = uuid(103);
    await client.query(
      "INSERT INTO users (id, normalized_email, display_name, locale) VALUES ($1,'schema-meta@example.com','Meta','en')",
      [user],
    );
    await client.query(
      'INSERT INTO external_identities (user_id, provider, provider_subject, safe_metadata) VALUES ($1,\'google\',\'ok\', \'{"schemaVersion":1,"issuer":"google","tenant":"test"}\'::jsonb)',
      [user],
    );
    await expectPgError(
      () =>
        client.query(
          "INSERT INTO external_identities (user_id, provider, provider_subject, safe_metadata) VALUES ($1,'google','token', '{\"schemaVersion\":1,\"token\":\"redacted\"}'::jsonb)",
          [user],
        ),
      { code: "23514", constraint: "external_identities_safe_metadata_check" },
    );
    await expectPgError(
      () =>
        client.query(
          "INSERT INTO external_identities (user_id, provider, provider_subject, safe_metadata) VALUES ($1,'google','nested', '{\"schemaVersion\":1,\"issuer\":{\"nested\":true}}'::jsonb)",
          [user],
        ),
      { code: "23514", constraint: "external_identities_safe_metadata_check" },
    );
    await expectPgError(
      () =>
        client.query(
          "INSERT INTO external_identities (user_id, provider, provider_subject, safe_metadata) VALUES ($1,'google','string-version', '{\"schemaVersion\":\"1\"}'::jsonb)",
          [user],
        ),
      { code: "23514", constraint: "external_identities_safe_metadata_check" },
    );
    await client.query(
      "INSERT INTO organizations (slug, type, personal_owner_user_id) VALUES ('schema-personal-a','personal',$1)",
      [user],
    );
    await expectPgError(
      () =>
        client.query(
          "INSERT INTO organizations (slug, type, personal_owner_user_id) VALUES ('schema-personal-b','personal',$1)",
          [user],
        ),
      { code: "23505", constraint: "organizations_personal_owner_user_id_key" },
    );
    await client.query(
      "INSERT INTO organizations (slug, type) VALUES ('schema-team-a','team'),('schema-team-b','team')",
    );
  });

  it("enforces outbox state constraints and indexes", async () => {
    const indexes = await client.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename='outbox_events'",
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        "idx_outbox_events_pending_claim",
        "idx_outbox_events_expired_claim",
      ]),
    );
    await expectPgError(
      () =>
        client.query(
          "INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, schema_version, payload, occurred_at, available_at, claim_owner) VALUES ('organization',$1,'x.y',2,'{}',now(),now(),'worker')",
          [uuid(301)],
        ),
      { code: "23514" },
    );
    await expectPgError(
      () =>
        client.query(
          "INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, schema_version, payload, occurred_at, available_at, processed_at, terminal_error_code) VALUES ('organization',$1,'x.y',2,'{}',now(),now(),now(),'failed')",
          [uuid(302)],
        ),
      { code: "23514" },
    );
  });
});
