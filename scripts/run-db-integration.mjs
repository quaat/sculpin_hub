import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";

const schemaPath = "packages/db/prisma/schema.prisma";
const suitesDir = "packages/db/src";
const expectedSuites = new Set([
  "readiness.integration.test.ts",
  "schema.integration.test.ts",
  "tenant.integration.test.ts",
  "outbox.integration.test.ts",
]);

function quoteIdentifier(value) {
  return '"' + value.replaceAll('"', '""') + '"';
}

async function discoverIntegrationSuites() {
  const entries = await readdir(suitesDir, { withFileTypes: true });
  const files = entries
    .filter(
      (entry) =>
        entry.isFile() && entry.name.endsWith(".integration.test.ts"),
    )
    .map((entry) => join(suitesDir, entry.name))
    .sort();
  if (files.length === 0)
    throw new Error("No database integration suites found.");
  const discovered = new Set(files.map((file) => basename(file)));
  for (const expected of expectedSuites) {
    if (!discovered.has(expected))
      throw new Error(`Missing expected database integration suite: ${expected}`);
  }
  return files;
}

if (process.argv.includes("--list-suites")) {
  const suites = await discoverIntegrationSuites();
  console.log(
    `database integration suites: ${suites.map((suite) => basename(suite)).join(", ")}`,
  );
  process.exit(0);
}

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) throw new Error("DATABASE_URL is required for integration tests.");
const suffix = `${Date.now()}_${process.pid}`;
const databaseName = `sculpin_integration_test_${suffix}`;
const adminUrl = new URL(baseUrl);
adminUrl.pathname = "/postgres";
const testUrl = new URL(baseUrl);
testUrl.pathname = `/${databaseName}`;
const { default: pg } = await import("pg");
const admin = new pg.Client({ connectionString: adminUrl.toString() });
const suites = await discoverIntegrationSuites();
await admin.connect();
try {
  await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
  const migrate = spawnSync(
    "pnpm",
    ["prisma", "migrate", "deploy", "--schema", schemaPath],
    {
      stdio: "inherit",
      env: { ...process.env, DATABASE_URL: testUrl.toString() },
    },
  );
  if (migrate.status !== 0) {
    process.exitCode = migrate.status ?? 1;
    throw new Error("Database integration migration failed.");
  }
  const result = spawnSync(
    process.execPath,
    [
      "./node_modules/vitest/vitest.mjs",
      "run",
      "--fileParallelism=false",
      ...suites,
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        DATABASE_URL: testUrl.toString(),
        RUN_DATABASE_INTEGRATION: "true",
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
