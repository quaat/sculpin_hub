import { describe, expect, it, vi } from "vitest";
import { GET as live } from "./live/route";
import { createReadinessHandler } from "./ready/handler";
const env = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://test:test@localhost/test",
};
describe("web health", () => {
  it("returns liveness without checking dependencies", async () => {
    const response = live();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", service: "web" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("reports ready only when the database responds", async () => {
    const handler = createReadinessHandler(
      env,
      () => ({
        pool: {} as never,
        ready: () => Promise.resolve(true),
        close: vi.fn(),
      }),
      { warn: vi.fn() },
    );
    const response = await handler();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "ready", service: "web" });
  });
  it("reports not ready for a failed dependency", async () => {
    const handler = createReadinessHandler(
      env,
      () => ({
        pool: {} as never,
        ready: () => Promise.reject(new Error("secret internal detail")),
        close: () => Promise.resolve(),
      }),
      { warn: vi.fn() },
    );
    const response = await handler();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = JSON.stringify(await response.json());
    expect(body).not.toContain("secret internal detail");
    expect(body).not.toContain("database");
  });
});
