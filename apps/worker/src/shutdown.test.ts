import { describe, expect, it, vi } from "vitest";
import { createShutdownController } from "./shutdown.js";
const timer = {} as ReturnType<typeof setTimeout>;
describe("worker shutdown", () => {
  it("runs once and clears its timeout", async () => {
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const clearTimer = vi.fn();
    const controller = createShutdownController({
      shutdown,
      timeoutMs: 10,
      logger: { info: vi.fn(), error: vi.fn(), fatal: vi.fn() },
      exit: vi.fn(),
      setTimer: vi.fn().mockReturnValue(timer),
      clearTimer,
    });
    await Promise.all([controller("SIGTERM"), controller("SIGINT")]);
    expect(shutdown).toHaveBeenCalledOnce();
    expect(clearTimer).toHaveBeenCalledWith(timer);
  });
  it("exits non-zero on rejection without leaking through the signal callback", async () => {
    const exit = vi.fn();
    const error = vi.fn();
    const controller = createShutdownController({
      shutdown: async () => {
        throw new Error("canary");
      },
      timeoutMs: 10,
      logger: { info: vi.fn(), error, fatal: vi.fn() },
      exit,
      setTimer: vi.fn().mockReturnValue(timer),
      clearTimer: vi.fn(),
    });
    await expect(controller("SIGTERM")).resolves.toBeUndefined();
    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalled();
  });
  it("forces exit when shutdown times out", () => {
    const exit = vi.fn();
    let callback = () => undefined;
    createShutdownController({
      shutdown: () => new Promise(() => undefined),
      timeoutMs: 10,
      logger: { info: vi.fn(), error: vi.fn(), fatal: vi.fn() },
      exit,
      setTimer: vi.fn((fn) => {
        callback = fn;
        return timer;
      }),
      clearTimer: vi.fn(),
    })("SIGTERM");
    callback();
    expect(exit).toHaveBeenCalledWith(1);
  });
});
