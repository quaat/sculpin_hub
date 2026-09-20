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
  PostgresPlanRepository,
  PostgresSubscriptionRepository,
  type Database,
} from "@sculpin/db";
import type { FastifyInstance } from "fastify";
import { createSecureProductionProxyServer } from "./server.js";

/**
 * Deterministic end-to-end proof (Stage F) that a STOCK OpenAI client works
 * against the Hub's secure `/v1` broker with a real minted PAT, a real
 * PostgreSQL, and a fake (in-process) Sculpin upstream — no live external calls.
 *
 * Rebuilt around D-019 (explicit subscription claim; no auto-trial on
 * provisioning): every tenant's entitlement is constructed through the REAL
 * repositories — `PostgresPlanRepository` (create + attach offering) and
 * `PostgresSubscriptionRepository.grantFromPlan` (materialize + snapshot). A
 * freshly provisioned tenant has NO subscription and is therefore DENIED (403),
 * which is the load-bearing D-019 invariant this suite proves at the network
 * edge. It also re-asserts the credential boundary (CLAUDE.md rules 2-5): the
 * caller's PAT/cookies never reach the upstream, only the Hub credential does,
 * the public alias is rewritten to/from the internal agent id, and — critically
 * for §4 — NO pre-dispatch denial (401/403/404/429) ever reaches the upstream.
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
// The seeded free-trial plan's FIXED uuid (migration 20260920180000_plan_domain).
const SEEDED_FREE_TRIAL_PLAN_ID = "00000000-0000-4000-8000-0000000f7a11";

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
  // Non-standard upstream metadata the Hub must strip (S12) before the client
  // ever sees it.
  exodus: { conversation_id: "internal-conversation-e2e" },
};

const chunkFrame = (delta: string): string =>
  `data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"${UPSTREAM_AGENT_ID}","choices":[{"index":0,"delta":${delta},"finish_reason":null}]}\n\n`;

// The upstream stream is split into a HEAD (role + first content + a keepalive
// comment) and a TAIL (second content + stop + terminal DONE). The fake upstream
// flushes the HEAD, then blocks on `streamTailGate` before the TAIL. This lets
// the incremental test hold the tail closed until the stock SDK has already
// yielded the first content chunk — a whole-stream buffer would deadlock here.
const SSE_HEAD = [
  chunkFrame(`{"role":"assistant"}`),
  ": keep-alive\n\n",
  chunkFrame(`{"content":"hi"}`),
].join("");
const SSE_TAIL = [
  chunkFrame(`{"content":" there"}`),
  `data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"${UPSTREAM_AGENT_ID}","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`,
  "data: [DONE]\n\n",
].join("");

// A deterministic streaming barrier. Default: already open, so ordinary stream
// tests stream head+tail without pausing. The incremental test installs a fresh
// pending gate via `armStreamTailGate()` and opens it only AFTER the SDK yields
// the first content chunk, proving the proxy forwards incrementally.
let streamTailGate: Promise<void> = Promise.resolve();
function armStreamTailGate(): () => void {
  let open!: () => void;
  streamTailGate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return open;
}

// Client-supplied headers the caller must NEVER be able to smuggle upstream
// (conversation isolation, S11/D-022): a raw upstream conversation id and the
// metadata opt-in are dropped at the Hub, never relayed to Sculpin.
const SMUGGLED_HEADERS = {
  cookie: "session=leak",
  "x-random-header": "nope",
  "x-exodus-conversation-id": "client-forged-conversation",
  "x-agent-platform-include-metadata": "true",
} as const;

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
  let scopedToken: string;
  let revokedToken: string;
  let noSubToken: string;
  let primaryOrgId: string;
  let primaryPatId: string;
  let supportEntryId: string;
  const captured: CapturedUpstreamRequest[] = [];

  async function usageRowCount(organizationId: string): Promise<number> {
    const { rows } = await database.pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM usage_events WHERE organization_id=$1",
      [organizationId],
    );
    return Number(rows[0]?.n ?? 0);
  }

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
        // Upstream conversation headers the Hub must NEVER return to the client
        // (S11/D-022). They are emitted here to prove the response allowlist
        // strips them at the edge.
        const upstreamResponseHeaders = {
          "x-exodus-conversation-id": "internal-conversation-header",
          "x-exodus-conversation-reused": "false",
          server: "uvicorn",
        };
        if (body.stream) {
          response.writeHead(200, {
            "content-type": "text/event-stream",
            ...upstreamResponseHeaders,
          });
          // Flush the head, then hold the tail behind the barrier. Over loopback
          // a chunked write is delivered immediately, so the proxy can forward
          // the first chunk to the SDK while this handler is still parked.
          response.write(SSE_HEAD);
          await streamTailGate;
          response.end(SSE_TAIL);
        } else {
          response.writeHead(200, {
            "content-type": "application/json",
            ...upstreamResponseHeaders,
          });
          response.end(JSON.stringify(COMPLETION_BODY));
        }
      })();
    });
    await new Promise<void>((resolve) =>
      fakeSculpin.listen(0, "127.0.0.1", resolve),
    );
    const sculpinPort = (fakeSculpin.address() as AddressInfo).port;

    database = createDatabase(process.env.DATABASE_URL);

    const tenant = new PostgresPersonalTenantTransaction(database.pool);
    const catalogue = new PostgresCatalogueRepository(database.pool);
    const plans = new PostgresPlanRepository(database.pool);
    const subscriptions = new PostgresSubscriptionRepository(database.pool);
    const pat = new PostgresPatService(database.pool, PAT_HASH_KEYRING);

    // Primary tenant A. Provisioning grants NO subscription (D-019) — the
    // subscription is claimed EXPLICITLY below via a real plan grant.
    const primary = await tenant.create({
      normalizedEmail: "e2e-user@example.com",
      displayName: "E2E User",
      locale: "en",
      organizationSlug: "e2e-user-org",
      requestId: "e2e-user",
    });
    primaryOrgId = primary.organizationId;

    // A PUBLISHED catalogue alias -> internal agent (the entitled offering).
    const entry = await catalogue.create(
      {
        publicAlias: PUBLIC_ALIAS,
        upstreamAgentId: UPSTREAM_AGENT_ID,
        displayName: "Support",
      },
      primary.userId,
    );
    await catalogue.publish(entry.id, primary.userId);
    supportEntryId = entry.id;
    // A second catalogue entry that EXISTS (so a PAT may scope to it) but is
    // never granted by any plan — used to prove PAT-scope exclusion yields 404.
    const premiumEntry = await catalogue.create(
      {
        publicAlias: "premium",
        upstreamAgentId: "agent-premium-e2e",
        displayName: "Premium",
      },
      primary.userId,
    );

    // D-019 explicit claim: an admin-created plan whose authoritative offering
    // set is {support}, granted to tenant A. `grantFromPlan` SNAPSHOTS the
    // plan's current catalogue-entry set onto the subscription in one commit.
    const supportPlan = await plans.create(
      {
        key: "e2e-support-plan",
        name: "E2E Support Plan",
        kind: "commercial_monthly",
        requestQuota: 200,
        oneTimePerOrganization: false,
      },
      primary.userId,
    );
    await plans.attachCatalogueEntry(supportPlan.id, supportEntryId);
    const primarySub = await subscriptions.grantFromPlan(
      primary.organizationId,
      supportPlan.id,
      primary.userId,
    );
    // The subscription froze the plan's offering set (support) at grant time.
    expect(primarySub.offerings).toContain(supportEntryId);
    expect(primarySub.status).toBe("active");

    const primaryPat = await pat.mint({
      userId: primary.userId,
      organizationId: primary.organizationId,
      name: "e2e-primary",
    });
    goodToken = primaryPat.token;
    primaryPatId = primaryPat.record.id;
    // A PAT scoped to ONLY the premium entry: it may never reach `support`
    // (authorized = entitled ∩ scopes = ∅), so a support request is a 404.
    scopedToken = (
      await pat.mint({
        userId: primary.userId,
        organizationId: primary.organizationId,
        name: "e2e-scoped-premium",
        scopeCatalogueEntryIds: [premiumEntry.id],
      })
    ).token;
    // A PAT minted then immediately revoked: revocation must take effect at once.
    const toRevoke = await pat.mint({
      userId: primary.userId,
      organizationId: primary.organizationId,
      name: "e2e-revoked",
    });
    revokedToken = toRevoke.token;
    await pat.revoke(toRevoke.record.id, primary.userId);

    // Tenant B: provisioned but NEVER claims a plan. Per D-019 it has NO
    // subscription, so every data-plane request is DENIED (403) and the
    // upstream is never contacted. This is the core no-auto-trial proof.
    const unsubscribed = await tenant.create({
      normalizedEmail: "e2e-nosub@example.com",
      displayName: "E2E NoSub",
      locale: "en",
      organizationSlug: "e2e-nosub-org",
      requestId: "e2e-nosub",
    });
    noSubToken = (
      await pat.mint({
        userId: unsubscribed.userId,
        organizationId: unsubscribed.organizationId,
        name: "e2e-nosub",
      })
    ).token;

    // Tenant C: an active subscription that GRANTS support but whose quota is
    // fully drained, to prove 429 fail-closed (distinct from the 403 no-sub
    // case — here entitlement is active, only the budget is exhausted).
    const drained = await tenant.create({
      normalizedEmail: "e2e-drained@example.com",
      displayName: "E2E Drained",
      locale: "en",
      organizationSlug: "e2e-drained-org",
      requestId: "e2e-drained",
    });
    const drainedSub = await subscriptions.grantFromPlan(
      drained.organizationId,
      supportPlan.id,
      primary.userId,
    );
    await database.pool.query(
      "UPDATE subscriptions SET quota_used = quota_limit WHERE id=$1",
      [drainedSub.id],
    );
    drainedToken = (
      await pat.mint({
        userId: drained.userId,
        organizationId: drained.organizationId,
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
      upstreamTimeoutMs: 30_000,
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
      // Extra caller headers that MUST NOT be forwarded to Sculpin (incl. a
      // client-forged upstream conversation id and the metadata opt-in).
      defaultHeaders: { ...SMUGGLED_HEADERS },
      maxRetries: 0,
    });
  }

  /**
   * Assert that a pre-dispatch denial NEVER reaches the fake upstream: capture
   * the recorded-request count before, run the request (expecting it to reject
   * with `status`), and assert the count is unchanged (§4 security matrix).
   */
  async function expectDeniedNoUpstream(
    run: () => Promise<unknown>,
    matcher: Record<string, unknown>,
  ): Promise<void> {
    const before = captured.length;
    await expect(run()).rejects.toMatchObject(matcher);
    expect(captured.length).toBe(before);
  }

  it("seeds the D-019 free-trial plan with a fixed uuid, quota 200, no offerings", async () => {
    // The seeded default claim target exists exactly as the migration declares
    // (published + self-service, one-time, quota 200) and — importantly — grants
    // NO offerings until an admin attaches them. Tenant A is entitled via the
    // SEPARATE explicit plan above, never via this seed.
    const { rows } = await database.pool.query<{
      key: string;
      published: boolean;
      self_service_eligible: boolean;
      one_time_per_organization: boolean;
      request_quota: number;
      offerings: number;
    }>(
      `SELECT p.key, p.published, p.self_service_eligible,
              p.one_time_per_organization, p.request_quota,
              (SELECT count(*)::int FROM plan_catalogue_entries pce
                WHERE pce.plan_id = p.id) AS offerings
         FROM plans p WHERE p.id = $1`,
      [SEEDED_FREE_TRIAL_PLAN_ID],
    );
    expect(rows[0]).toMatchObject({
      key: "free-trial",
      published: true,
      self_service_eligible: true,
      one_time_per_organization: true,
      request_quota: 200,
      offerings: 0,
    });
  });

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
    // S12: the non-standard upstream `exodus` metadata is stripped client-side.
    expect(JSON.stringify(completion)).not.toContain("exodus");
    expect(JSON.stringify(completion)).not.toContain("internal-conversation-e2e");
    // The upstream saw the rewritten agent id and the Hub credential only.
    const upstream = captured[before];
    expect(upstream?.body.model).toBe(UPSTREAM_AGENT_ID);
    expect(upstream?.headers.authorization).toBe(`Bearer ${UPSTREAM_KEY}`);
    expect(upstream?.headers.cookie).toBeUndefined();
    expect(upstream?.headers["x-random-header"]).toBeUndefined();
    // Conversation isolation (S11/D-022): a caller-forged upstream conversation
    // id and the metadata opt-in are NEVER relayed to Sculpin.
    expect(upstream?.headers["x-exodus-conversation-id"]).toBeUndefined();
    expect(
      upstream?.headers["x-agent-platform-include-metadata"],
    ).toBeUndefined();
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
    expect(content).toBe("hi there");
    // The internal upstream agent id never reaches the client stream.
    expect(raw.join("")).not.toContain(UPSTREAM_AGENT_ID);
  });

  it("streams INCREMENTALLY: the SDK yields the first chunk before the upstream emits the final frame (no whole-stream buffering)", async () => {
    // Arm the barrier so the fake upstream flushes only the HEAD (role + first
    // content + keepalive), then parks before the TAIL. We open the gate ONLY
    // after the stock SDK has already yielded the first content chunk. If the
    // proxy buffered the whole stream it could not deliver that first chunk
    // (the upstream is parked), so this loop would hang and the test time out —
    // completion therefore proves genuine incremental forwarding.
    const openTail = armStreamTailGate();
    const stream = await client(goodToken).chat.completions.create({
      model: PUBLIC_ALIAS,
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });

    let content = "";
    let firstContentSeen = false;
    const modelsSeen: string[] = [];
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta.content ?? "";
      if (delta && !firstContentSeen) {
        firstContentSeen = true;
        // Holding the tail closed, we already received chunk one — release it.
        openTail();
      }
      content += delta;
      if (chunk.model) modelsSeen.push(chunk.model);
    }

    expect(firstContentSeen).toBe(true);
    // Head ("hi") + tail (" there") both arrive across the barrier, in order.
    expect(content).toBe("hi there");
    // Per-chunk rewrite: every chunk model is the public alias, never the id.
    expect(modelsSeen.length).toBeGreaterThan(0);
    for (const model of modelsSeen) expect(model).toBe(PUBLIC_ALIAS);
    // Explicit bound: if a regression made the proxy buffer the whole stream,
    // this loop would deadlock on the parked upstream — fail fast, don't hang.
  }, 15_000);

  it("denies a provisioned tenant with NO subscription (403) and never calls upstream (D-019)", async () => {
    // The core D-019 proof: provisioning did NOT auto-grant a trial, so this
    // tenant is not entitled. Both the models projection and chat are denied
    // with 403, and the upstream is never contacted.
    await expectDeniedNoUpstream(() => client(noSubToken).models.list(), {
      status: 403,
      code: "no_active_subscription",
    });
    await expectDeniedNoUpstream(
      () =>
        client(noSubToken).chat.completions.create({
          model: PUBLIC_ALIAS,
          messages: [{ role: "user", content: "x" }],
        }),
      { status: 403, code: "no_active_subscription" },
    );
  });

  it("returns 404 for an unknown model without calling upstream", async () => {
    await expectDeniedNoUpstream(
      () =>
        client(goodToken).chat.completions.create({
          model: "ghost",
          messages: [{ role: "user", content: "x" }],
        }),
      { status: 404 },
    );
  });

  it("returns 429 and never calls upstream when the tenant is out of quota", async () => {
    await expectDeniedNoUpstream(
      () =>
        client(drainedToken).chat.completions.create({
          model: PUBLIC_ALIAS,
          messages: [{ role: "user", content: "x" }],
        }),
      { status: 429 },
    );
  });

  it("rejects a bogus PAT with 401 and never calls upstream", async () => {
    await expectDeniedNoUpstream(
      () => client(`sclp_pat_${"Z".repeat(22)}_${"z".repeat(43)}`).models.list(),
      { status: 401 },
    );
  });

  it("rejects a revoked PAT with 401 immediately and never calls upstream", async () => {
    await expectDeniedNoUpstream(() => client(revokedToken).models.list(), {
      status: 401,
    });
  });

  it("returns 404 for a model excluded by the PAT scope, without calling upstream", async () => {
    await expectDeniedNoUpstream(
      () =>
        client(scopedToken).chat.completions.create({
          model: PUBLIC_ALIAS,
          messages: [{ role: "user", content: "x" }],
        }),
      { status: 404 },
    );
  });

  it("never returns the upstream conversation headers to the client (S11)", async () => {
    const { response } = await client(goodToken)
      .chat.completions.create({
        model: PUBLIC_ALIAS,
        messages: [{ role: "user", content: "hi" }],
      })
      .withResponse();
    // The response the SDK sees carries ONLY the safe allowlist — the upstream
    // conversation headers and server banner are stripped at the edge.
    expect(response.headers.get("x-exodus-conversation-id")).toBeNull();
    expect(response.headers.get("x-exodus-conversation-reused")).toBeNull();
    expect(response.headers.get("server")).toBeNull();
  });

  it("records exactly one usage event per served request and none for denials", async () => {
    const beforeGrant = await usageRowCount(primaryOrgId);
    await client(goodToken).chat.completions.create({
      model: PUBLIC_ALIAS,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(await usageRowCount(primaryOrgId)).toBe(beforeGrant + 1);
    // The newest usage row carries only safe correlation ids: the resolved
    // catalogue-entry id, the PAT ROW id (never the token secret), and cost 1.
    const { rows } = await database.pool.query<{
      catalogue_entry_id: string;
      pat_id: string;
      quota_cost: number;
      request_id: string;
    }>(
      `SELECT catalogue_entry_id, pat_id, quota_cost, request_id
       FROM usage_events WHERE organization_id=$1
       ORDER BY occurred_at DESC LIMIT 1`,
      [primaryOrgId],
    );
    expect(rows[0]).toMatchObject({
      catalogue_entry_id: supportEntryId,
      pat_id: primaryPatId,
      quota_cost: 1,
    });
    // No secret ever lands in the usage row.
    const patSecret = goodToken.split("_")[3];
    expect(patSecret).toBeTruthy();
    expect(JSON.stringify(rows[0])).not.toContain(patSecret!);

    // A denied request (unknown model → 404) writes NO usage event.
    const afterGrant = await usageRowCount(primaryOrgId);
    await expect(
      client(goodToken).chat.completions.create({
        model: "ghost",
        messages: [{ role: "user", content: "x" }],
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(await usageRowCount(primaryOrgId)).toBe(afterGrant);
  });
});
