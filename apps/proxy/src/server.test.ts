import { describe, expect, it, vi } from "vitest";
import type { ProxyConfig } from "@sculpin/config";
import type { Database } from "@sculpin/db";
import {
  createTestRouteRegistry,
  emptyProductionRouteRegistry,
} from "./registry.js";
import { createProductionProxyServer, createProxyServer } from "./server.js";
const config: ProxyConfig = {
  environment: "test",
  logLevel: "silent",
  databaseUrl: "postgresql://unused/test",
  port: 3001,
  host: "127.0.0.1",
  bodyLimitBytes: 4096,
};
function database(ready = true): Database {
  return {
    pool: {} as never,
    ready: vi.fn().mockResolvedValue(ready),
    close: vi.fn().mockResolvedValue(undefined),
  };
}
describe("proxy foundation", () => {
  it("serves liveness and accurate readiness", async () => {
    const server = createProductionProxyServer(config, database(true));
    expect((await server.inject("/health/live")).json()).toEqual({
      status: "ok",
      service: "proxy",
    });
    expect((await server.inject("/health/ready")).statusCode).toBe(200);
    await server.close();
  });
  it("returns 503 when the database is unavailable", async () => {
    const server = createProductionProxyServer(config, database(false));
    expect((await server.inject("/health/ready")).statusCode).toBe(503);
    await server.close();
  });
  it("normalizes every unsupported v1 operation without forwarding", async () => {
    const server = createProductionProxyServer(config, database());
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "anything" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        message: "The requested API operation is not available.",
        type: "invalid_request_error",
        param: null,
        code: "unsupported_operation",
      },
    });
    await server.close();
  });
  it("propagates a safe correlation ID", async () => {
    const server = createProductionProxyServer(config, database());
    const response = await server.inject({
      url: "/health/live",
      headers: { "x-request-id": "request_test-123" },
    });
    expect(response.headers["x-request-id"]).toBe("request_test-123");
    await server.close();
  });
  it("keeps the production registry empty", () => {
    expect(emptyProductionRouteRegistry().routes).toHaveLength(0);
  });
  it("allows synthetic routes only through direct test composition", async () => {
    const registry = createTestRouteRegistry([
      {
        method: "GET",
        path: "/v1/test-synthetic",
        handler: () => ({ synthetic: true }),
      },
    ]);
    const server = createProxyServer(config, {
      database: database(),
      registry,
    });
    expect((await server.inject("/v1/test-synthetic")).json()).toEqual({
      synthetic: true,
    });
    await server.close();
  });
  it("normalizes internal exceptions without leaking details", async () => {
    const registry = createTestRouteRegistry([
      {
        method: "GET",
        path: "/v1/test-error",
        handler: () => {
          throw new Error("canary internal stack");
        },
      },
    ]);
    const server = createProxyServer(config, {
      database: database(),
      registry,
    });
    const response = await server.inject("/v1/test-error");
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("canary internal stack");
    expect(response.json<{ error: { code: string } }>().error.code).toBe(
      "internal_error",
    );
    await server.close();
  });
});
