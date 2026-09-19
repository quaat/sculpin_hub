import { spawnSync } from "node:child_process";

/**
 * Deterministic proxy end-to-end runner (Stage F). Mirrors
 * `run-db-integration.mjs`: provisions an ephemeral database, deploys the Prisma
 * migrations, runs ONLY the proxy E2E suite (real proxy + fake Sculpin + stock
 * OpenAI SDK), then drops the database. No live external calls.
 */
const schemaPath = "packages/db/prisma/schema.prisma";
const suiteFile = "apps/proxy/src/proxy.e2e.test.ts";

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) throw new Error("DATABASE_URL is required for the proxy E2E.");
const suffix = `${Date.now()}_${process.pid}`;
const databaseName = `sculpin_proxy_e2e_${suffix}`;
const adminUrl = new URL(baseUrl);
adminUrl.pathname = "/postgres";
const testUrl = new URL(baseUrl);
testUrl.pathname = `/${databaseName}`;

function quoteIdentifier(value) {
  return '"' + value.replaceAll('"', '""') + '"';
}

const { default: pg } = await import("pg");
const admin = new pg.Client({ connectionString: adminUrl.toString() });
await admin.connect();
try {
  await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
  const migrate = spawnSync(
    process.execPath,
    [
      "node_modules/prisma/build/index.js",
      "migrate",
      "deploy",
      "--schema",
      schemaPath,
    ],
    {
      stdio: "inherit",
      env: { ...process.env, DATABASE_URL: testUrl.toString() },
    },
  );
  if (migrate.status !== 0) {
    process.exitCode = migrate.status ?? 1;
    throw new Error("Proxy E2E migration failed.");
  }
  const result = spawnSync(
    process.execPath,
    [
      "./node_modules/vitest/vitest.mjs",
      "run",
      "--fileParallelism=false",
      suiteFile,
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        DATABASE_URL: testUrl.toString(),
        RUN_PROXY_E2E: "true",
      },
    },
  );
  process.exitCode = result.status ?? 1;
} finally {
  await admin.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1",
    [databaseName],
  );
  await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
  await admin.end();
}
