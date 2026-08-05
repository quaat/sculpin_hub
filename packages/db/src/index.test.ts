import { afterEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, createDatabase, getDatabase } from "./index.js";

const prismaClient = () =>
  ({
    $connect: vi.fn().mockResolvedValue(undefined),
    $disconnect: vi.fn().mockResolvedValue(undefined),
  }) as never;

afterEach(() => closeDatabase());

describe("database lifecycle", () => {
  it("runs bounded Prisma and pg readiness checks", async () => {
    const client = prismaClient();
    const database = createDatabase("postgresql://ignored/test", {
      prismaClient: client,
      readinessTimeoutMs: 321,
    });
    const query = vi
      .spyOn(database.pool, "query")
      .mockResolvedValue({ rows: [{ ready: 1 }] } as never);
    expect(await database.ready()).toBe(true);
    expect(client.$connect).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith({
      text: "SELECT 1 AS ready",
      query_timeout: 321,
    });
    vi.spyOn(database.pool, "end").mockResolvedValue(undefined);
    await database.close();
  });

  it("creates Prisma once and reuses it across repeated readiness checks", async () => {
    const client = prismaClient();
    const factory = vi.fn().mockResolvedValue(client);
    const database = createDatabase("postgresql://ignored/test", {
      prismaClientFactory: factory,
    });
    vi.spyOn(database.pool, "query").mockResolvedValue({
      rows: [{ ready: 1 }],
    } as never);
    vi.spyOn(database.pool, "end").mockResolvedValue(undefined);
    await expect(database.ready()).resolves.toBe(true);
    await expect(database.ready()).resolves.toBe(true);
    expect(factory).toHaveBeenCalledOnce();
    expect(client.$connect).toHaveBeenCalledTimes(2);
    expect(database.prisma).toBe(client);
    await database.close();
  });

  it("fails readiness safely when Prisma connection fails", async () => {
    const client = prismaClient();
    vi.mocked(client.$connect).mockRejectedValueOnce(
      new Error("connect failed"),
    );
    const database = createDatabase("postgresql://ignored/test", {
      prismaClient: client,
    });
    const query = vi.spyOn(database.pool, "query");
    vi.spyOn(database.pool, "end").mockResolvedValue(undefined);
    await expect(database.ready()).rejects.toThrow("connect failed");
    expect(query).not.toHaveBeenCalled();
    await database.close();
  });

  it("fails readiness safely when pg readiness fails", async () => {
    const client = prismaClient();
    const database = createDatabase("postgresql://ignored/test", {
      prismaClient: client,
    });
    vi.spyOn(database.pool, "query").mockRejectedValueOnce(
      new Error("pg failed"),
    );
    vi.spyOn(database.pool, "end").mockResolvedValue(undefined);
    await expect(database.ready()).rejects.toThrow("pg failed");
    expect(client.$connect).toHaveBeenCalledOnce();
    await database.close();
  });

  it("closes Prisma and pg exactly once", async () => {
    const client = prismaClient();
    const database = createDatabase("postgresql://ignored/test", {
      prismaClient: client,
    });
    const end = vi.spyOn(database.pool, "end").mockResolvedValue(undefined);
    await Promise.all([database.close(), database.close()]);
    expect(end).toHaveBeenCalledOnce();
    expect(client.$disconnect).toHaveBeenCalledOnce();
  });

  it("closes deterministically while initialization is pending", async () => {
    const client = prismaClient();
    let resolveFactory: (client: typeof client) => void = () => undefined;
    const factory = vi.fn(
      () => new Promise<typeof client>((resolve) => (resolveFactory = resolve)),
    );
    const database = createDatabase("postgresql://ignored/test", {
      prismaClientFactory: factory,
    });
    vi.spyOn(database.pool, "query").mockResolvedValue({
      rows: [{ ready: 1 }],
    } as never);
    const end = vi.spyOn(database.pool, "end").mockResolvedValue(undefined);
    const ready = database.ready();
    const closed = database.close();
    resolveFactory(client);
    await expect(ready).resolves.toBe(true);
    await closed;
    expect(factory).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
    expect(client.$disconnect).toHaveBeenCalledOnce();
  });

  it("reports idle pool errors through the supplied safe callback", () => {
    const onPoolError = vi.fn();
    const database = createDatabase("postgresql://ignored/test", {
      prismaClient: prismaClient(),
      onPoolError,
    });
    const failure = new Error("pool failure");
    database.pool.emit("error", failure, {} as never);
    expect(onPoolError).toHaveBeenCalledWith(failure);
    vi.spyOn(database.pool, "end").mockResolvedValue(undefined);
    return database.close();
  });

  it("rejects singleton reuse for a different connection target", () => {
    const first = getDatabase("postgresql://ignored/one", {
      prismaClient: prismaClient(),
    });
    expect(getDatabase("postgresql://ignored/one")).toBe(first);
    expect(() => getDatabase("postgresql://ignored/two")).toThrow(
      "different connection target",
    );
    vi.spyOn(first.pool, "end").mockResolvedValue(undefined);
  });
});
