import { describe, expect, it, vi } from "vitest";
import { openAiErrorSchema } from "@sculpin/api-contracts";
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
  shutdownTimeoutMs: 10000,
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
    const live = await server.inject("/health/live");
    expect(live.json()).toEqual({
      status: "ok",
      service: "proxy",
    });
    expect(live.headers["cache-control"]).toBe("no-store");
    const ready = await server.inject("/health/ready");
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: "ready", service: "proxy" });
    expect(ready.headers["cache-control"]).toBe("no-store");
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
    expect(openAiErrorSchema.parse(response.json()).error.code).toBe(
      "internal_error",
    );
    await server.close();
  });
});

describe("proxy client error semantics", () => {
  it("returns safe 400 for malformed JSON", async () => {
    const server = createProductionProxyServer(config, database());
    const response = await server.inject({
      method: "POST",
      url: "/v1/example",
      headers: { "content-type": "application/json" },
      payload: '{"broken":',
    });
    expect(response.statusCode).toBe(400);
    expect(openAiErrorSchema.parse(response.json()).error.code).toBe(
      "invalid_json",
    );
    expect(response.body).not.toContain("broken");
    expect(response.headers["cache-control"]).toBe("no-store");
    await server.close();
  });
  it("returns safe 413 for an oversized body", async () => {
    const server = createProductionProxyServer(config, database());
    const response = await server.inject({
      method: "POST",
      url: "/v1/example",
      payload: { value: "x".repeat(5000) },
    });
    expect(response.statusCode).toBe(413);
    expect(openAiErrorSchema.parse(response.json()).error.code).toBe(
      "request_too_large",
    );
    await server.close();
  });
  it("returns safe 415 for unsupported media", async () => {
    const server = createProductionProxyServer(config, database());
    const response = await server.inject({
      method: "POST",
      url: "/v1/example",
      headers: { "content-type": "application/xml" },
      payload: "<x/>",
    });
    expect(response.statusCode).toBe(415);
    expect(openAiErrorSchema.parse(response.json()).error.code).toBe(
      "unsupported_media_type",
    );
    await server.close();
  });
  it("returns safe 400 for invalid request input", async () => {
    const registry = createTestRouteRegistry([
      {
        method: "POST",
        path: "/v1/test-invalid",
        handler: () => {
          throw Object.assign(new Error("canary validation detail"), {
            statusCode: 400,
            validation: [],
          });
        },
      },
    ]);
    const server = createProxyServer(config, {
      database: database(),
      registry,
    });
    const response = await server.inject({
      method: "POST",
      url: "/v1/test-invalid",
    });
    expect(response.statusCode).toBe(400);
    expect(openAiErrorSchema.parse(response.json()).error.code).toBe(
      "invalid_request",
    );
    expect(response.body).not.toContain("canary validation detail");
    await server.close();
  });
  it.each([
    ["GET", "/v1"],
    ["POST", "/v1/"],
    ["DELETE", "/v1/nested/operation"],
  ] as const)("normalizes %s %s as unsupported", async (method, url) => {
    const server = createProductionProxyServer(config, database());
    const response = await server.inject({ method, url });
    expect(response.statusCode).toBe(404);
    expect(openAiErrorSchema.parse(response.json()).error.code).toBe(
      "unsupported_operation",
    );
    expect(response.headers["x-request-id"]).toBeTruthy();
    expect(response.headers["cache-control"]).toBe("no-store");
    await server.close();
  });
  it("replaces an unsafe request ID", async () => {
    const server = createProductionProxyServer(config, database());
    const response = await server.inject({
      url: "/v1",
      headers: { "x-request-id": "unsafe id with spaces" },
    });
    expect(response.headers["x-request-id"]).not.toBe("unsafe id with spaces");
    expect(String(response.headers["x-request-id"])).toMatch(
      /^[A-Za-z0-9-]{8,}$/,
    );
    await server.close();
  });
  it("leaves injected databases caller-owned", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const injected = { ...database(), close };
    const server = createProductionProxyServer(config, injected);
    await server.close();
    expect(close).not.toHaveBeenCalled();
  });
  it("closes server-created databases exactly once", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const owned = { ...database(), close };
    const server = createProxyServer(config, {
      registry: emptyProductionRouteRegistry(),
      databaseFactory: () => owned,
    });
    await server.close();
    await server.close();
    expect(close).toHaveBeenCalledOnce();
  });
});
