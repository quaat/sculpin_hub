import { afterAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "./index.js";
const enabled = process.env.RUN_DATABASE_INTEGRATION === "true";
const suite = enabled ? describe : describe.skip;
suite("PostgreSQL integration", () => {
  let database: Database | undefined;
  afterAll(() => database?.close());
  it("executes the real SELECT 1 readiness query", async () => {
    const url = process.env.DATABASE_URL;
    if (!url)
      throw new Error(
        "DATABASE_URL is required for the database integration test.",
      );
    database = createDatabase(url, { readinessTimeoutMs: 2_000 });
    await expect(database.ready()).resolves.toBe(true);
  });
});
