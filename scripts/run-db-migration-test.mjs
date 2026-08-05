import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";

async function expectSqlFailure(client, sql) {
  try {
    await client.query(sql);
  } catch {
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
      "INSERT INTO organization_memberships (organization_id, user_id, role) VALUES ('00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000001','owner')",
    );
    await test.query(
      "INSERT INTO audit_events (organization_id, actor_user_id, action, target_type, target_id, after_summary, request_id, occurred_at) VALUES ('00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000001','personal_organization.created','organization','00000000-0000-4000-8000-000000000101','{}','migration-test',now())",
    );
    await expectSqlFailure(
      test,
      "UPDATE audit_events SET request_id='changed'",
    );
    await expectSqlFailure(
      test,
      "INSERT INTO external_identities (user_id, provider, provider_subject, safe_metadata) VALUES ('00000000-0000-4000-8000-000000000001','google','sub', '{\"schemaVersion\":1,\"token\":\"secret-value\"}'::jsonb)",
    );
    await expectSqlFailure(
      test,
      "INSERT INTO outbox_events (organization_id, aggregate_type, aggregate_id, event_type, schema_version, payload, occurred_at, available_at) VALUES ('00000000-0000-4000-8000-000000000101','organization','00000000-0000-4000-8000-000000000101','personal_organization.created',1,'{\"organizationId\":\"00000000-0000-4000-8000-000000000101\",\"userId\":\"00000000-0000-4000-8000-000000000999\"}'::jsonb,now(),now())",
    );
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
