import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openAiErrorSchema } from "@sculpin/api-contracts";
import type { ProxyConfig } from "@sculpin/config";
import type { Database } from "@sculpin/db";
import {
  createDataPlaneRouteRegistry,
  type DataPlaneServices,
} from "./data-plane.js";
import { createProxyServer } from "./server.js";
import type { SculpinUpstream } from "./upstream.js";

/**
 * S6/S10 cancellation semantics on a REAL socket. `server.inject`
 * (light-my-request) cannot model a genuine client disconnect, so these tests
 * boot a real listening Fastify proxy and drive it with the Node http client so
 * we can destroy the socket mid-flight. The upstream is a fake that records
 * whether ITS abort signal fired, proving disconnects propagate (and, crucially,
 * that a NORMAL completion does not spuriously abort the upstream).
 */

const config: ProxyConfig = {
  environment: "test",
  logLevel: "silent",
  databaseUrl: "postgresql://unused/test",
  port: 0,
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
  scopes: [] as string[],
};

function baseServices(upstream: SculpinUpstream, upstreamTimeoutMs = 5000): DataPlaneServices {
  return {
    authenticate: (token) =>
      Promise.resolve(token === GOOD_TOKEN ? IDENTITY : undefined),
    resolveEntitlement: (organizationId) =>
      Promise.resolve({
        organizationId,
        active: true,
        planKeys: ["free-trial"],
        remainingQuota: 100,
        entitledCatalogueEntryIds: ["entry-support"],
      }),
    reserveQuota: () => Promise.resolve({ granted: true, remainingQuota: 99 }),
    listPublishedModels: () =>
      Promise.resolve([
        { id: "support", catalogueEntryId: "entry-support", created: 1720000000 },
      ]),
    resolvePublishedAlias: (alias) =>
      Promise.resolve(
        alias === "support"
          ? { catalogueEntryId: "entry-support", upstreamAgentId: "agent-uuid-123" }
          : undefined,
      ),
    upstream,
    upstreamTimeoutMs,
  };
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const servers: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});

async function listen(services: DataPlaneServices): Promise<number> {
  const server = createProxyServer(config, {
    database: database(),
    registry: createDataPlaneRouteRegistry(services),
  });
  servers.push({ close: () => server.close() });
  await server.listen({ port: 0, host: "127.0.0.1" });
  return (server.server.address() as AddressInfo).port;
}

interface DriveOptions {
  readonly payload: unknown;
  /** Called once the first response byte arrives (to disconnect mid-stream). */
  readonly onFirstByte?: (req: http.ClientRequest) => void;
  /** Called right after the request is sent (to disconnect pre-headers). */
  readonly onSent?: (req: http.ClientRequest) => void;
}

interface DriveResult {
  readonly statusCode: number | undefined;
  readonly body: string;
  readonly errored: boolean;
}

function drive(port: number, options: DriveOptions): Promise<DriveResult> {
  return new Promise((resolve) => {
    let firstByteSeen = false;
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          authorization: `Bearer ${GOOD_TOKEN}`,
          "content-type": "application/json",
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
          if (!firstByteSeen) {
            firstByteSeen = true;
            options.onFirstByte?.(req);
          }
        });
        res.on("end", () =>
          resolve({ statusCode: res.statusCode, body, errored: false }),
        );
        res.on("error", () =>
          resolve({ statusCode: res.statusCode, body, errored: true }),
        );
      },
    );
    req.on("error", () =>
      resolve({ statusCode: undefined, body: "", errored: true }),
    );
    req.end(JSON.stringify(options.payload));
    options.onSent?.(req);
  });
}

const payload = { model: "support", messages: [{ role: "user", content: "hi" }] };

describe("data-plane cancellation (real socket)", () => {
  it("does NOT abort the upstream on a normal completed request", async () => {
    let aborted = false;
    const upstream: SculpinUpstream = {
      chatCompletions: (_p, { signal }) => {
        signal.addEventListener("abort", () => {
          aborted = true;
        });
        return Promise.resolve(
          new Response(JSON.stringify({ id: "x", model: "agent-uuid-123" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      },
    };
    const port = await listen(baseServices(upstream));
    const result = await drive(port, { payload });
    expect(result.statusCode).toBe(200);
    expect(result.errored).toBe(false);
    // The client-visible model is the alias; the internal id is rewritten out.
    expect(result.body).toContain('"model":"support"');
    // Give the raw-socket 'close' a tick; a normal completion must NOT abort.
    await new Promise((r) => setTimeout(r, 30));
    expect(aborted).toBe(false);
  });

  it("aborts the upstream run when the client disconnects before headers", async () => {
    const abortSeen = deferred();
    const upstream: SculpinUpstream = {
      chatCompletions: (_p, { signal }) =>
        new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            abortSeen.resolve();
            reject(new Error("aborted"));
          });
        }),
    };
    const port = await listen(baseServices(upstream));
    const result = await drive(port, {
      payload,
      onSent: (req) => setTimeout(() => req.destroy(), 150),
    });
    // The client tore down the connection; the request errors client-side and
    // NO synthetic response body was written to the gone socket.
    expect(result.errored).toBe(true);
    expect(result.statusCode).toBeUndefined();
    // The proxy propagated the disconnect to the upstream run.
    await abortSeen.promise;
  });

  it("aborts the upstream run when the client disconnects mid-SSE stream", async () => {
    const abortSeen = deferred();
    const upstream: SculpinUpstream = {
      chatCompletions: (_p, { signal }) => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const enc = new TextEncoder();
            // One real frame so the client gets headers + a first byte, then the
            // stream stays open until the client disconnects.
            controller.enqueue(
              enc.encode(
                'data: {"id":"c","model":"agent-uuid-123","choices":[]}\n\n',
              ),
            );
            signal.addEventListener("abort", () => {
              abortSeen.resolve();
              try {
                controller.close();
              } catch {
                /* already closed */
              }
            });
          },
        });
        return Promise.resolve(
          new Response(stream, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
        );
      },
    };
    const port = await listen(baseServices(upstream));
    const result = await drive(port, {
      payload: { ...payload, stream: true },
      onFirstByte: (req) => setTimeout(() => req.destroy(), 20),
    });
    expect(result.body).toContain('"model":"support"');
    expect(result.body).not.toContain("agent-uuid-123");
    await abortSeen.promise;
  });

  it("returns a sanitized 504 when the upstream never returns headers in time", async () => {
    const upstream: SculpinUpstream = {
      chatCompletions: (_p, { signal }) =>
        new Promise<Response>((_resolve, reject) => {
          // Never resolves on its own; only the header-timeout abort rejects it.
          signal.addEventListener("abort", () =>
            reject(new Error("ECONNREFUSED internal-sculpin:8001")),
          );
        }),
    };
    const port = await listen(baseServices(upstream, 30));
    const result = await drive(port, { payload });
    expect(result.statusCode).toBe(504);
    expect(result.errored).toBe(false);
    expect(openAiErrorSchema.parse(JSON.parse(result.body)).error.code).toBe(
      "upstream_timeout",
    );
    expect(result.body).not.toContain("internal-sculpin");
    expect(result.body).not.toContain("ECONNREFUSED");
  });
});
