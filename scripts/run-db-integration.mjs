import { spawnSync } from "node:child_process";
const result = spawnSync(
  process.execPath,
  [
    "./node_modules/vitest/vitest.mjs",
    "run",
    "packages/db/src/integration.test.ts",
  ],
  {
    stdio: "inherit",
    env: { ...process.env, RUN_DATABASE_INTEGRATION: "true" },
  },
);
process.exitCode = result.status ?? 1;
