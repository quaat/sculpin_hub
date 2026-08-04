import { describe, expect, it, vi } from "vitest";
import { createDatabase } from "./index.js";
describe("database readiness", () => {
  it("runs the lightweight readiness query", async () => {
    const database = createDatabase("postgresql://ignored/test");
    const query = vi
      .spyOn(database.pool, "query")
      .mockResolvedValue({ rows: [{ ready: 1 }] } as never);
    expect(await database.ready()).toBe(true);
    expect(query).toHaveBeenCalledWith("SELECT 1 AS ready");
    vi.spyOn(database.pool, "end").mockResolvedValue(undefined);
    await database.close();
  });
  it("does not convert connection errors into ready state", async () => {
    const database = createDatabase("postgresql://ignored/test");
    vi.spyOn(database.pool, "query").mockRejectedValue(
      new Error("unavailable"),
    );
    await expect(database.ready()).rejects.toThrow("unavailable");
    vi.spyOn(database.pool, "end").mockResolvedValue(undefined);
    await database.close();
  });
});
