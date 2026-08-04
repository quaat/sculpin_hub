import { describe, expect, it, vi, afterEach } from "vitest";
import { closeDatabase, createDatabase, getDatabase } from "./index.js";
afterEach(() => closeDatabase());
describe("database lifecycle", () => {
  it("runs a bounded lightweight readiness query", async () => {
    const database = createDatabase("postgresql://ignored/test", {
      readinessTimeoutMs: 321,
    });
    const query = vi
      .spyOn(database.pool, "query")
      .mockResolvedValue({ rows: [{ ready: 1 }] } as never);
    expect(await database.ready()).toBe(true);
    expect(query).toHaveBeenCalledWith({
      text: "SELECT 1 AS ready",
      query_timeout: 321,
    });
    vi.spyOn(database.pool, "end").mockResolvedValue(undefined);
    await database.close();
  });
  it("closes a pool at most once", async () => {
    const database = createDatabase("postgresql://ignored/test");
    const end = vi.spyOn(database.pool, "end").mockResolvedValue(undefined);
    await Promise.all([database.close(), database.close()]);
    expect(end).toHaveBeenCalledOnce();
  });
  it("reports idle pool errors through the supplied safe callback", () => {
    const onPoolError = vi.fn();
    const database = createDatabase("postgresql://ignored/test", {
      onPoolError,
    });
    const failure = new Error("pool failure");
    database.pool.emit("error", failure, {} as never);
    expect(onPoolError).toHaveBeenCalledWith(failure);
    vi.spyOn(database.pool, "end").mockResolvedValue(undefined);
    return database.close();
  });
  it("rejects singleton reuse for a different connection target", () => {
    const first = getDatabase("postgresql://ignored/one");
    expect(getDatabase("postgresql://ignored/one")).toBe(first);
    expect(() => getDatabase("postgresql://ignored/two")).toThrow(
      "different connection target",
    );
    vi.spyOn(first.pool, "end").mockResolvedValue(undefined);
  });
});
