import { describe, expect, it, vi } from "vitest";
import { openAiErrorSchema } from "@sculpin/api-contracts";
import type { ProxyConfig } from "@sculpin/config";
import type { Database } from "@sculpin/db";
import {
  createDataPlaneRouteRegistry,
  extractBearerToken,
  type DataPlaneServices,
} from "./data-plane.js";
import { createProxyServer } from "./server.js";
import { createSculpinUpstream, type FetchLike } from "./upstream.js";

type Authenticate = DataPlaneServices["authenticate"];
type ResolveEntitlement = DataPlaneServices["resolveEntitlement"];
type ReserveQuota = DataPlaneServices["reserveQuota"];
type ListPublishedModels = DataPlaneServices["listPublishedModels"];
type ResolvePublishedAlias = DataPlaneServices["resolvePublishedAlias"];
type ChatCompletions = DataPlaneServices["upstream"]["chatCompletions"];

const config: ProxyConfig = {
  environment: "test",
  logLevel: "silent",
  databaseUrl: "postgresql://unused/test",
  port: 3001,
  host: "127.0.0.1",
  bodyLimitBytes: 65536,
  shutdownTimeoutMs: 10000,
};

function database(): Database {
  return {
    pool: {} as never,
    prisma: {} as never,
    ready: vi.fn().mockResolvedValue(true),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

const GOOD_TOKEN = `sclp_pat_${"A".repeat(22)}_${"b".repeat(43)}`;
const IDENTITY = {
  patId: "pat-1",
  userId: "user-1",
  organizationId: "org-1",
  scopes: [],
};

function services(overrides: Partial<DataPlaneServices> = {}): DataPlaneServices {
  return {
    authenticate: vi
      .fn<Authenticate>()
      .mockImplementation((token) =>
        Promise.resolve(token === GOOD_TOKEN ? IDENTITY : undefined),
      ),
    resolveEntitlement: vi
      .fn<ResolveEntitlement>()
      .mockImplementation((organizationId) =>
        Promise.resolve({
          organizationId,
          active: true,
          planKeys: ["free-trial"],
          remainingQuota: 100,
          entitledCatalogueEntryIds: [],
        }),
      ),
    reserveQuota: vi
      .fn<ReserveQuota>()
      .mockResolvedValue({ granted: true, remainingQuota: 99 }),
    listPublishedModels: vi
      .fn<ListPublishedModels>()
      .mockResolvedValue([{ id: "support", created: 1720000000 }]),
    resolvePublishedAlias: vi
      .fn<ResolvePublishedAlias>()
      .mockImplementation((alias) =>
        Promise.resolve(
          alias === "support" ? { upstreamAgentId: "agent-uuid-123" } : undefined,
        ),
      ),
    upstream: {
      chatCompletions: vi
        .fn<ChatCompletions>()
        .mockResolvedValue(new Response("{}")),
    },
    ...overrides,
  };
}

function serverWith(dataPlane: DataPlaneServices) {
  return createProxyServer(config, {
    database: database(),
    registry: createDataPlaneRouteRegistry(dataPlane),
  });
}

function errorCode(body: unknown): string {
  return openAiErrorSchema.parse(body).error.code;
}

function sseResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const auth = { authorization: `Bearer ${GOOD_TOKEN}` };

describe("extractBearerToken", () => {
  it("parses the Bearer scheme case-insensitively and falls back to a bare token", () => {
    expect(extractBearerToken("Bearer abc")).toBe("abc");
    expect(extractBearerToken("bearer abc")).toBe("abc");
    expect(extractBearerToken("Bearer   spaced  ")).toBe("spaced");
    expect(extractBearerToken("bare-token")).toBe("bare-token");
    expect(extractBearerToken(["Bearer first", "second"])).toBe("first");
    expect(extractBearerToken(undefined)).toBeUndefined();
    expect(extractBearerToken("   ")).toBeUndefined();
  });
});

describe("GET /v1/models", () => {
  it("denies a missing or malformed token with a single opaque 401", async () => {
    const server = serverWith(services());
    const missing = await server.inject("/v1/models");
    expect(missing.statusCode).toBe(401);
    expect(errorCode(missing.json())).toBe("invalid_api_key");
    expect(missing.headers["www-authenticate"]).toBe("Bearer");
    const bad = await server.inject({
      url: "/v1/models",
      headers: { authorization: "Bearer not-a-pat" },
    });
    expect(bad.statusCode).toBe(401);
    await server.close();
  });

  it("denies a caller without an active subscription", async () => {
    const server = serverWith(
      services({
        resolveEntitlement: vi.fn<ResolveEntitlement>().mockResolvedValue({
          organizationId: "org-1",
          active: false,
          planKeys: [],
          remainingQuota: 0,
          entitledCatalogueEntryIds: [],
        }),
      }),
    );
    const response = await server.inject({ url: "/v1/models", headers: auth });
    expect(response.statusCode).toBe(403);
    expect(errorCode(response.json())).toBe("no_active_subscription");
    await server.close();
  });

  it("lists ONLY published public aliases, never the upstream mapping", async () => {
    const chatCompletions = vi.fn<ChatCompletions>();
    const server = serverWith(services({ upstream: { chatCompletions } }));
    const response = await server.inject({ url: "/v1/models", headers: auth });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      object: "list",
      data: [
        {
          id: "support",
          object: "model",
          created: 1720000000,
          owned_by: "sculpin-hub",
        },
      ],
    });
    expect(response.body).not.toContain("agent-uuid");
    expect(chatCompletions).not.toHaveBeenCalled();
    await server.close();
  });
});

describe("POST /v1/chat/completions", () => {
  const body = {
    model: "support",
    messages: [{ role: "user", content: "hello" }],
  };

  it("denies a missing token before touching the body", async () => {
    const resolveEntitlement = vi.fn<ResolveEntitlement>().mockResolvedValue({
      organizationId: "org-1",
      active: true,
      planKeys: ["free-trial"],
      remainingQuota: 100,
      entitledCatalogueEntryIds: [],
    });
    const server = serverWith(services({ resolveEntitlement }));
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: body,
    });
    expect(response.statusCode).toBe(401);
    expect(resolveEntitlement).not.toHaveBeenCalled();
    await server.close();
  });

  it("rejects a body missing model or messages", async () => {
    const server = serverWith(services());
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: { messages: [] },
    });
    expect(response.statusCode).toBe(400);
    expect(errorCode(response.json())).toBe("invalid_request");
    await server.close();
  });

  it("returns 404 for an unknown model WITHOUT reserving quota or calling upstream", async () => {
    const reserveQuota = vi
      .fn<ReserveQuota>()
      .mockResolvedValue({ granted: true, remainingQuota: 99 });
    const chatCompletions = vi.fn<ChatCompletions>();
    const server = serverWith(
      services({ reserveQuota, upstream: { chatCompletions } }),
    );
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: { model: "ghost", messages: [{ role: "user", content: "x" }] },
    });
    expect(response.statusCode).toBe(404);
    expect(errorCode(response.json())).toBe("model_not_found");
    expect(reserveQuota).not.toHaveBeenCalled();
    expect(chatCompletions).not.toHaveBeenCalled();
    await server.close();
  });

  it("returns 429 and never calls upstream when quota is exhausted", async () => {
    const chatCompletions = vi.fn<ChatCompletions>();
    const server = serverWith(
      services({
        reserveQuota: vi
          .fn<ReserveQuota>()
          .mockResolvedValue({ granted: false, remainingQuota: 0 }),
        upstream: { chatCompletions },
      }),
    );
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: body,
    });
    expect(response.statusCode).toBe(429);
    expect(errorCode(response.json())).toBe("insufficient_quota");
    expect(chatCompletions).not.toHaveBeenCalled();
    await server.close();
  });

  it("resolves the alias, reserves one unit, and passes the JSON response through", async () => {
    const upstreamBody = {
      id: "chatcmpl-1",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hi" },
          finish_reason: "stop",
        },
      ],
    };
    const chatCompletions = vi.fn<ChatCompletions>().mockResolvedValue(
      new Response(JSON.stringify(upstreamBody), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-exodus-conversation-id": "conv-1",
          "set-cookie": "leak=1",
          server: "uvicorn",
        },
      }),
    );
    const reserveQuota = vi
      .fn<ReserveQuota>()
      .mockResolvedValue({ granted: true, remainingQuota: 99 });
    const server = serverWith(
      services({ reserveQuota, upstream: { chatCompletions } }),
    );
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: body,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(upstreamBody);
    // Alias rewritten to the upstream agent id; client fields preserved.
    expect(chatCompletions).toHaveBeenCalledOnce();
    const [payload] = chatCompletions.mock.calls[0]!;
    expect(payload).toEqual({
      model: "agent-uuid-123",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(reserveQuota).toHaveBeenCalledWith("org-1", 1);
    // Response header allowlist: continuity header passes, cookies/server drop.
    expect(response.headers["x-exodus-conversation-id"]).toBe("conv-1");
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.headers.server).toBeUndefined();
    await server.close();
  });

  it("passes an SSE stream through byte-for-byte", async () => {
    const frames = [
      'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const chatCompletions = vi
      .fn<ChatCompletions>()
      .mockResolvedValue(sseResponse(frames));
    const server = serverWith(services({ upstream: { chatCompletions } }));
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { ...auth, "content-type": "application/json" },
      payload: { ...body, stream: true },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/event-stream");
    expect(response.body).toBe(frames.join(""));
    await server.close();
  });

  it("returns 502 without leaking details when the upstream call fails", async () => {
    const chatCompletions = vi
      .fn<ChatCompletions>()
      .mockRejectedValue(new Error("ECONNREFUSED internal-sculpin:8001"));
    const server = serverWith(services({ upstream: { chatCompletions } }));
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: body,
    });
    expect(response.statusCode).toBe(502);
    expect(errorCode(response.json())).toBe("upstream_unavailable");
    expect(response.body).not.toContain("internal-sculpin");
    expect(response.body).not.toContain("ECONNREFUSED");
    await server.close();
  });

  it("never forwards the caller's PAT, cookies, or Authorization to the outbound fetch", async () => {
    // Wire the REAL upstream module (not a mock) through a fetch spy so the full
    // pipeline -> credential boundary is exercised end to end (CLAUDE.md 3/4).
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const upstream = createSculpinUpstream(
      {
        sculpinUpstreamUrl: "http://internal-sculpin:8001",
        sculpinUpstreamApiKey: "sk-upstream-secret-xyz",
      },
      fetchMock,
    );
    const server = serverWith(services({ upstream }));
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        ...auth,
        cookie: "session=super-secret",
        "content-type": "application/json",
      },
      payload: body,
    });
    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://internal-sculpin:8001/v1/chat/completions");
    const headers = init.headers as Headers;
    // The caller's PAT is terminated and the Hub credential is injected instead.
    expect(headers.get("authorization")).toBe("Bearer sk-upstream-secret-xyz");
    expect(headers.get("authorization")).not.toContain(GOOD_TOKEN);
    expect(headers.get("cookie")).toBeNull();
    // The outbound request body never carries the caller's secrets either.
    expect(typeof init.body).toBe("string");
    const outboundBody = init.body as string;
    expect(outboundBody).not.toContain(GOOD_TOKEN);
    expect(outboundBody).not.toContain("super-secret");
    await server.close();
  });
});
