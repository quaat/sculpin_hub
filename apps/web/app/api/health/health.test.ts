import { describe, expect, it, vi } from "vitest";
import { GET as live } from "./live/route";
import { createReadinessHandler } from "./ready/handler";
const env: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://test:test@localhost/test",
};
describe("web health", () => {
  it("returns liveness without checking dependencies", async () => {
    const response = live();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", service: "web" });
  });
  it("reports ready only when the database responds", async () => {
    const handler = createReadinessHandler(env, () => ({
      pool: {} as never,
      ready: () => Promise.resolve(true),
      close: vi.fn(),
    }));
    const response = await handler();
    expect(response.status).toBe(200);
  });
  it("reports not ready for a failed dependency", async () => {
    const handler = createReadinessHandler(env, () => ({
      pool: {} as never,
      ready: () => Promise.reject(new Error("secret internal detail")),
      close: () => Promise.resolve(),
    }));
    const response = await handler();
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain(
      "secret internal detail",
    );
  });
});
