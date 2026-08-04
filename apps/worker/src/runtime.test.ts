import { describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import type { Database } from "@sculpin/db";
import { createIdleJobRunner } from "@sculpin/jobs";
import { WorkerRuntime } from "./runtime.js";
describe("worker runtime", () => {
  it("initializes the database, stays idle without handlers, and shuts down once", async () => {
    const ready = vi.fn().mockResolvedValue(true);
    const close = vi.fn().mockResolvedValue(undefined);
    const db: Database = { pool: {} as never, ready, close };
    const logger = { info: vi.fn() } as unknown as Logger;
    const runtime = new WorkerRuntime(db, createIdleJobRunner(), logger);
    await runtime.start();
    await runtime.stop("SIGTERM");
    await runtime.stop("SIGINT");
    expect(ready).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith(
      "no production job handlers registered; worker is idle",
    );
  });
  it("fails clearly if its required database is unavailable", async () => {
    const db: Database = {
      pool: {} as never,
      ready: vi.fn().mockResolvedValue(false),
      close: vi.fn(),
    };
    const runtime = new WorkerRuntime(db, createIdleJobRunner(), {
      info: vi.fn(),
    } as unknown as Logger);
    await expect(runtime.start()).rejects.toThrow("database readiness");
  });
});
