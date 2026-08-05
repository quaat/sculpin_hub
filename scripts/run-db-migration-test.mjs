import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";

async function expectSqlFailure(client, sql, expected) {
  try {
    await client.query(sql);
  } catch (error) {
    if (expected.code && error.code !== expected.code)
      throw new Error(`Expected SQLSTATE ${expected.code}, got ${error.code}`);
    if (expected.constraint && error.constraint !== expected.constraint)
      throw new Error(
        `Expected constraint ${expected.constraint}, got ${error.constraint}`,
      );
    if (expected.message && !expected.message.test(error.message ?? ""))
      throw new Error(`Unexpected SQL error message: ${error.message}`);
    return;
  }
  throw new Error("Expected SQL invariant failure.");
}

const exec = promisify(execFile);
const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) throw new Error("DATABASE_URL is required for migration tests.");
const suffix = `${Date.now()}_${process.pid}`;
const databaseName = `sculpin_migration_test_${suffix}`;
const shadowDatabaseName = `sculpin_migration_shadow_${suffix}`;
const adminUrl = new URL(baseUrl);
const originalDatabase = adminUrl.pathname.slice(1);
adminUrl.pathname = "/postgres";
const admin = new pg.Client({ connectionString: adminUrl.toString() });
await admin.connect();
try {
  await admin.query(`CREATE DATABASE ${databaseName}`);
  await admin.query(`CREATE DATABASE ${shadowDatabaseName}`);
  const testUrl = new URL(baseUrl);
  testUrl.pathname = `/${databaseName}`;
  const shadowUrl = new URL(baseUrl);
  shadowUrl.pathname = `/${shadowDatabaseName}`;
  const env = {
    ...process.env,
    DATABASE_URL: testUrl.toString(),
    SHADOW_DATABASE_URL: shadowUrl.toString(),
  };
  await exec("pnpm", ["db:migrate:deploy"], { env });
  await exec("pnpm", ["db:migrate:deploy"], { env });
  await exec(
    "pnpm",
    [
      "prisma",
      "migrate",
      "status",
      "--schema",
      "packages/db/prisma/schema.prisma",
    ],
    { env },
  );
  await exec(
    "pnpm",
    ["prisma", "validate", "--schema", "packages/db/prisma/schema.prisma"],
    { env },
  );
  await exec(
    "pnpm",
    ["prisma", "generate", "--schema", "packages/db/prisma/schema.prisma"],
    { env },
  );
  await exec(
    "pnpm",
    [
      "prisma",
      "migrate",
      "diff",
      "--from-migrations",
      "packages/db/prisma/migrations",
      "--to-schema-datamodel",
      "packages/db/prisma/schema.prisma",
      "--shadow-database-url",
      shadowUrl.toString(),
      "--exit-code",
    ],
    { env },
  );
  const test = new pg.Client({ connectionString: testUrl.toString() });
  await test.connect();
  try {
    await test.query(
      "INSERT INTO users (id, normalized_email, display_name, locale) VALUES ('00000000-0000-4000-8000-000000000001','owner@example.com','Owner','en')",
    );
    await test.query(
      "INSERT INTO organizations (id, slug, type, personal_owner_user_id) VALUES ('00000000-0000-4000-8000-000000000101','owner-personal','personal','00000000-0000-4000-8000-000000000001')",
    );
    await test.query(
      "INSERT INTO organizations (slug, type) VALUES ('migration-team-a','team'),('migration-team-b','team')",
    );
    await expectSqlFailure(
      test,
      "INSERT INTO organizations (slug, type, personal_owner_user_id) VALUES ('owner-personal-2','personal','00000000-0000-4000-8000-000000000001')",
      { code: "23505", constraint: "organizations_personal_owner_user_id_key" },
    );
    await test.query(
      "INSERT INTO organization_memberships (organization_id, user_id, role) VALUES ('00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000001','owner')",
    );
    await test.query(
      "INSERT INTO audit_events (organization_id, actor_user_id, action, target_type, target_id, after_summary, request_id, occurred_at) VALUES ('00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000001','personal_organization.created','organization','00000000-0000-4000-8000-000000000101','{}','migration-test',now())",
    );
    await expectSqlFailure(
      test,
      "UPDATE audit_events SET request_id='changed'",
      { code: "P0001", message: /append-only/ },
    );
    await expectSqlFailure(test, "DELETE FROM audit_events", {
      code: "P0001",
      message: /append-only/,
    });
    await test.query(
      "INSERT INTO external_identities (user_id, provider, provider_subject, safe_metadata) VALUES ('00000000-0000-4000-8000-000000000001','google','valid', '{\"schemaVersion\":1,\"issuer\":\"google\"}'::jsonb)",
    );
    await expectSqlFailure(
      test,
      "INSERT INTO external_identities (user_id, provider, provider_subject, safe_metadata) VALUES ('00000000-0000-4000-8000-000000000001','google','token', '{\"schemaVersion\":1,\"token\":\"redacted\"}'::jsonb)",
      { code: "23514", constraint: "external_identities_safe_metadata_check" },
    );
    await test.query(
      "INSERT INTO outbox_events (organization_id, aggregate_type, aggregate_id, event_type, schema_version, payload, occurred_at, available_at) VALUES ('00000000-0000-4000-8000-000000000101','organization','00000000-0000-4000-8000-000000000101','personal_organization.created',1,'{\"organizationId\":\"00000000-0000-4000-8000-000000000101\",\"userId\":\"00000000-0000-4000-8000-000000000001\"}'::jsonb,now(),now())",
    );
    await expectSqlFailure(
      test,
      "INSERT INTO outbox_events (organization_id, aggregate_type, aggregate_id, event_type, schema_version, payload, occurred_at, available_at) VALUES ('00000000-0000-4000-8000-000000000101','organization','00000000-0000-4000-8000-000000000101','personal_organization.created',1,'{\"organizationId\":\"00000000-0000-4000-8000-000000000101\",\"userId\":\"00000000-0000-4000-8000-000000000999\"}'::jsonb,now(),now())",
      { code: "P0001", message: /owner missing/ },
    );
    await expectSqlFailure(
      test,
      "INSERT INTO outbox_events (organization_id, aggregate_type, aggregate_id, event_type, schema_version, payload, occurred_at, available_at) VALUES ('00000000-0000-4000-8000-000000000101','organization','00000000-0000-4000-8000-000000000101','personal_organization.created',2,'{\"organizationId\":\"00000000-0000-4000-8000-000000000101\",\"userId\":\"00000000-0000-4000-8000-000000000001\"}'::jsonb,now(),now())",
      { code: "P0001", message: /shape mismatch/ },
    );
    await test.query(
      "INSERT INTO outbox_events (organization_id, aggregate_type, aggregate_id, event_type, schema_version, payload, occurred_at, available_at) VALUES ('00000000-0000-4000-8000-000000000101','organization','00000000-0000-4000-8000-000000000101','unrelated.event',1,'{}'::jsonb,now(),now())",
    );
    await expectSqlFailure(
      test,
      "INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, schema_version, payload, occurred_at, available_at, claim_owner) VALUES ('organization','00000000-0000-4000-8000-000000000201','x.y',2,'{}',now(),now(),'worker')",
      { code: "23514" },
    );
    const indexes = await test.query(
      "SELECT indexname FROM pg_indexes WHERE tablename IN ('organizations','outbox_events')",
    );
    const names = indexes.rows.map((row) => row.indexname);
    for (const required of [
      "organizations_personal_owner_user_id_key",
      "idx_outbox_events_pending_claim",
      "idx_outbox_events_expired_claim",
    ]) {
      if (!names.includes(required))
        throw new Error(`Missing expected index ${required}`);
    }
  } finally {
    await test.end();
  }
} finally {
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`,
    [databaseName],
  );
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`,
    [shadowDatabaseName],
  );
  await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
  await admin.query(`DROP DATABASE IF EXISTS ${shadowDatabaseName}`);
  await admin.end();
}
console.log(
  `Migration deployment is repeatable and drift-free from ${originalDatabase}.`,
);
