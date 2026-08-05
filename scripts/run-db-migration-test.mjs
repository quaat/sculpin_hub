import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";

const exec = promisify(execFile);
const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) throw new Error("DATABASE_URL is required for migration tests.");
const databaseName = `sculpin_migration_test_${Date.now()}_${process.pid}`;
const adminUrl = new URL(baseUrl);
const originalDatabase = adminUrl.pathname.slice(1);
adminUrl.pathname = "/postgres";
const admin = new pg.Client({ connectionString: adminUrl.toString() });
await admin.connect();
try {
  await admin.query(`CREATE DATABASE ${databaseName}`);
  const testUrl = new URL(baseUrl);
  testUrl.pathname = `/${databaseName}`;
  const env = { ...process.env, DATABASE_URL: testUrl.toString() };
  await exec("pnpm", ["db:migrate:deploy"], { env });
  await exec("pnpm", ["db:migrate:deploy"], { env });
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
      "--exit-code",
    ],
    { env },
  );
} finally {
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`,
    [databaseName],
  );
  await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
  await admin.end();
}
console.log(
  `Migration deployment is repeatable and drift-free from ${originalDatabase}.`,
);
