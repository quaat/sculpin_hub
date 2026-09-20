import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";
import OpenAI from "openai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DataPlaneConfig, ProxyConfig } from "@sculpin/config";
import {
  createDatabase,
  PostgresCatalogueRepository,
  PostgresPatService,
  PostgresPersonalTenantTransaction,
  type Database,
} from "@sculpin/db";
import type { FastifyInstance } from "fastify";
import { createSecureProductionProxyServer } from "./server.js";

/**
 * Deterministic end-to-end proof (Stage F) that a STOCK OpenAI client works
 * against the Hub's secure `/v1` broker with a real minted PAT, a real
 * PostgreSQL, and a fake (in-process) Sculpin upstream — no live external calls.
 * It exercises the whole M3/M4/M5/M6 slice at once and re-asserts the
 * credential boundary (CLAUDE.md rules 2-5) at the network edge: the caller's
 * PAT and cookies never reach the upstream; only the Hub credential does, and
 * the public alias is rewritten to the internal agent id.
 */
const enabled = process.env.RUN_PROXY_E2E === "true";
const suite = enabled ? describe : describe.skip;

const PAT_HASH_SECRET = "e2e-pat-hash-secret-least-32-chars-long!!";
const PAT_HASH_KEYRING = {
  currentVersion: 1,
  keys: new Map([[1, PAT_HASH_SECRET]]),
};
const UPSTREAM_KEY = "sk-upstream-e2e-secret-xyz";
const PUBLIC_ALIAS = "support";
const UPSTREAM_AGENT_ID = "agent-internal-uuid-e2e";

interface CapturedUpstreamRequest {
  readonly headers: IncomingHttpHeaders;
  readonly rawBody: string;
  readonly body: { model?: string; stream?: boolean };
}

const COMPLETION_BODY = {
  id: "chatcmpl-e2e",
  object: "chat.completion",
  created: 1_720_000_000,
  model: "sculpin",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "hello from sculpin" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

const SSE_FRAMES = [
  `data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"${UPSTREAM_AGENT_ID}","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n`,
  `data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"${UPSTREAM_AGENT_ID}","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n`,
  `data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"${UPSTREAM_AGENT_ID}","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`,
  "data: [DONE]\n\n",
].join("");

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    request.on("data", (chunk: Buffer) => (data += chunk.toString("utf8")));
    request.on("end", () => resolve(data));
    request.on("error", reject);
  });
}

suite("proxy end-to-end with the stock OpenAI SDK", () => {
  let database: Database;
  let proxy: FastifyInstance;
  let fakeSculpin: Server;
  let baseURL: string;
  let goodToken: string;
  let drainedToken: string;
  const captured: CapturedUpstreamRequest[] = [];

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");

    // Fake Sculpin upstream: records every inbound request and replies with an
    // OpenAI-shaped body (JSON or SSE, based on the `stream` flag).
    fakeSculpin = createServer((request, response) => {
      void (async () => {
        const rawBody = await readBody(request);
        const body = rawBody
          ? (JSON.parse(rawBody) as { model?: string; stream?: boolean })
          : {};
        captured.push({ headers: request.headers, rawBody, body });
        if (body.stream) {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(SSE_FRAMES);
        } else {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(COMPLETION_BODY));
        }
      })();
    });
    await new Promise<void>((resolve) =>
      fakeSculpin.listen(0, "127.0.0.1", resolve),
    );
    const sculpinPort = (fakeSculpin.address() as AddressInfo).port;

    database = createDatabase(process.env.DATABASE_URL);

    // Seed the control plane: a provisioned tenant (grants an active trial),
    // a PUBLISHED catalogue alias -> internal agent, and a real minted PAT.
    const tenant = new PostgresPersonalTenantTransaction(database.pool);
    const primary = await tenant.create({
      normalizedEmail: "e2e-user@example.com",
      displayName: "E2E User",
      locale: "en",
      organizationSlug: "e2e-user-org",
      requestId: "e2e-user",
    });
    const catalogue = new PostgresCatalogueRepository(database.pool);
    const entry = await catalogue.create(
      {
        publicAlias: PUBLIC_ALIAS,
        upstreamAgentId: UPSTREAM_AGENT_ID,
        displayName: "Support",
      },
      primary.userId,
    );
    await catalogue.publish(entry.id, primary.userId);
    const pat = new PostgresPatService(database.pool, PAT_HASH_KEYRING);
    goodToken = (
      await pat.mint({
        userId: primary.userId,
        organizationId: primary.organizationId,
        name: "e2e-primary",
      })
    ).token;

    // A second tenant whose quota is fully drained, to prove 429 fail-closed.
    const secondary = await tenant.create({
      normalizedEmail: "e2e-drained@example.com",
      displayName: "E2E Drained",
      locale: "en",
      organizationSlug: "e2e-drained-org",
      requestId: "e2e-drained",
    });
    await database.pool.query(
      "UPDATE subscriptions SET quota_limit=1, quota_used=1 WHERE organization_id=$1",
      [secondary.organizationId],
    );
    drainedToken = (
      await pat.mint({
        userId: secondary.userId,
        organizationId: secondary.organizationId,
        name: "e2e-drained",
      })
    ).token;

    const proxyConfig: ProxyConfig = {
      environment: "test",
      logLevel: "silent",
      databaseUrl: process.env.DATABASE_URL,
      port: 0,
      host: "127.0.0.1",
      bodyLimitBytes: 1_048_576,
      shutdownTimeoutMs: 10_000,
    };
    const dataPlaneConfig: DataPlaneConfig = {
      hubPublicUrl: "http://127.0.0.1",
      sculpinUpstreamUrl: `http://127.0.0.1:${sculpinPort}`,
      sculpinUpstreamApiKey: UPSTREAM_KEY,
      patHashSecret: PAT_HASH_SECRET,
      patHashKeyring: PAT_HASH_KEYRING,
    };
    proxy = createSecureProductionProxyServer(
      proxyConfig,
      dataPlaneConfig,
      database,
    );
    baseURL = `${await proxy.listen({ port: 0, host: "127.0.0.1" })}/v1`;
  });

  afterAll(async () => {
    await proxy?.close();
    await new Promise<void>((resolve, reject) =>
      fakeSculpin?.close((error) => (error ? reject(error) : resolve())),
    );
    await database?.close();
  });

  function client(token: string): OpenAI {
    return new OpenAI({
      apiKey: token,
      baseURL,
      // Extra caller headers that MUST NOT be forwarded to Sculpin.
      defaultHeaders: { cookie: "session=leak", "x-random-header": "nope" },
      maxRetries: 0,
    });
  }

  it("lists only the published public alias, never the upstream agent id", async () => {
    const list = await client(goodToken).models.list();
    const ids = list.data.map((model) => model.id);
    expect(ids).toEqual([PUBLIC_ALIAS]);
    expect(JSON.stringify(list.data)).not.toContain(UPSTREAM_AGENT_ID);
  });

  it("completes a non-streaming chat and passes the upstream body through", async () => {
    const before = captured.length;
    const completion = await client(goodToken).chat.completions.create({
      model: PUBLIC_ALIAS,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(completion.choices[0]?.message.content).toBe("hello from sculpin");
    // The client-visible model is the public alias, never the internal agent id.
    expect(completion.model).toBe(PUBLIC_ALIAS);
    expect(completion.model).not.toBe(UPSTREAM_AGENT_ID);
    // The upstream saw the rewritten agent id and the Hub credential only.
    const upstream = captured[before];
    expect(upstream?.body.model).toBe(UPSTREAM_AGENT_ID);
    expect(upstream?.headers.authorization).toBe(`Bearer ${UPSTREAM_KEY}`);
    expect(upstream?.headers.cookie).toBeUndefined();
    expect(upstream?.headers["x-random-header"]).toBeUndefined();
    // The caller's raw PAT never appears anywhere in the upstream request.
    const patPublicId = goodToken.split("_")[2];
    expect(patPublicId).toBeTruthy();
    expect(JSON.stringify(upstream)).not.toContain(patPublicId!);
  });

  it("streams an SSE completion through the stock SDK", async () => {
    const stream = await client(goodToken).chat.completions.create({
      model: PUBLIC_ALIAS,
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    let content = "";
    const raw: string[] = [];
    for await (const chunk of stream) {
      content += chunk.choices[0]?.delta.content ?? "";
      // Every chunk that carries a model shows the public alias, not the id.
      if (chunk.model) expect(chunk.model).toBe(PUBLIC_ALIAS);
      raw.push(JSON.stringify(chunk));
    }
    expect(content).toBe("hi");
    // The internal upstream agent id never reaches the client stream.
    expect(raw.join("")).not.toContain(UPSTREAM_AGENT_ID);
  });

  it("returns 404 for an unknown model without calling upstream", async () => {
    const before = captured.length;
    await expect(
      client(goodToken).chat.completions.create({
        model: "ghost",
        messages: [{ role: "user", content: "x" }],
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(captured.length).toBe(before);
  });

  it("returns 429 and never calls upstream when the tenant is out of quota", async () => {
    const before = captured.length;
    await expect(
      client(drainedToken).chat.completions.create({
        model: PUBLIC_ALIAS,
        messages: [{ role: "user", content: "x" }],
      }),
    ).rejects.toMatchObject({ status: 429 });
    expect(captured.length).toBe(before);
  });

  it("rejects a bogus PAT with 401", async () => {
    await expect(
      client(`sclp_pat_${"Z".repeat(22)}_${"z".repeat(43)}`).models.list(),
    ).rejects.toMatchObject({ status: 401 });
  });
});
