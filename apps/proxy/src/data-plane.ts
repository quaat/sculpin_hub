import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  authenticationError,
  chatCompletionRequestSchema,
  insufficientQuotaError,
  invalidRequestBodyError,
  modelNotFoundError,
  noActiveSubscriptionError,
  toModelList,
  upstreamUnavailableError,
} from "@sculpin/api-contracts";
import type { DataPlaneConfig } from "@sculpin/config";
import {
  PostgresCatalogueRepository,
  PostgresPatService,
  PostgresSubscriptionRepository,
  type Database,
} from "@sculpin/db";
import {
  authorizedCatalogueEntryIds,
  resolveEntitlement,
  type Entitlement,
  type PatIdentity,
  type QuotaReservation,
} from "@sculpin/domain";
import type { RouteRegistry } from "./registry.js";
import {
  createSseModelRewriteStream,
  rewriteModelInJsonBody,
} from "./rewrite.js";

type Pool = Database["pool"];
import {
  createSculpinUpstream,
  forwardableResponseHeaders,
  type FetchLike,
  type SculpinUpstream,
} from "./upstream.js";

/**
 * The secure data-plane pipeline (M6/M7). Every dependency is an interface so
 * unit tests run without a database or a live upstream. Nothing here reads the
 * upstream URL/key directly — that boundary lives only in `upstream.ts`.
 */
export interface DataPlaneServices {
  authenticate(token: string): Promise<PatIdentity | undefined>;
  resolveEntitlement(organizationId: string): Promise<Entitlement>;
  reserveQuota(
    organizationId: string,
    amount: number,
  ): Promise<QuotaReservation>;
  listPublishedModels(): Promise<
    readonly { id: string; catalogueEntryId: string; created: number }[]
  >;
  resolvePublishedAlias(
    alias: string,
  ): Promise<{ catalogueEntryId: string; upstreamAgentId: string } | undefined>;
  readonly upstream: SculpinUpstream;
}

export interface DataPlaneDeps {
  readonly fetch?: FetchLike;
  readonly now?: () => Date;
}

/** Each accepted chat completion reserves exactly one request-quota unit. */
const CHAT_QUOTA_COST = 1;

/**
 * Extract a bearer token from an `Authorization` header. Accepts the standard
 * `Bearer <token>` scheme (case-insensitive) and, as a fallback, a bare token.
 * Authentication treats any malformed value as a failure, so this never leaks a
 * parsing oracle.
 */
export function extractBearerToken(
  header: string | string[] | undefined,
): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const trimmed = value.trim();
  const match = /^Bearer\s+(.+)$/i.exec(trimmed);
  return (match?.[1] ?? trimmed).trim();
}

export function createDataPlaneServices(
  pool: Pool,
  config: DataPlaneConfig,
  deps: DataPlaneDeps = {},
): DataPlaneServices {
  const pat = new PostgresPatService(pool, config.patHashKeyring);
  const catalogue = new PostgresCatalogueRepository(pool);
  const subscriptions = new PostgresSubscriptionRepository(pool);
  const upstream = createSculpinUpstream(config, deps.fetch);
  const now = deps.now ?? (() => new Date());
  return {
    authenticate: (token) => pat.authenticate(token),
    async resolveEntitlement(organizationId) {
      const subs = await subscriptions.listForOrganization(organizationId);
      return resolveEntitlement(organizationId, subs, now());
    },
    reserveQuota: (organizationId, amount) =>
      subscriptions.reserveQuota(organizationId, amount),
    listPublishedModels: () => catalogue.listPublishedModels(),
    resolvePublishedAlias: (alias) => catalogue.resolvePublishedAlias(alias),
    upstream,
  };
}

async function authenticateRequest(
  services: DataPlaneServices,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<PatIdentity | undefined> {
  const token = extractBearerToken(request.headers.authorization);
  const identity = token ? await services.authenticate(token) : undefined;
  if (!identity) {
    // Single opaque failure; never reveal whether the token was malformed,
    // unknown, revoked, expired, or wrong-secret.
    void reply
      .code(401)
      .header("www-authenticate", "Bearer")
      .send(authenticationError());
    return undefined;
  }
  return identity;
}

function handleModels(services: DataPlaneServices) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const identity = await authenticateRequest(services, request, reply);
    if (!identity) return reply;
    const entitlement = await services.resolveEntitlement(
      identity.organizationId,
    );
    if (!entitlement.active)
      return reply.code(403).send(noActiveSubscriptionError());
    // S8 intersection: the caller may only SEE catalogue models in
    // published ∩ active-subscription offerings ∩ PAT scopes. Compute the
    // authorized catalogue-entry id set once, then filter the published list.
    const authorized = authorizedCatalogueEntryIds(
      entitlement.entitledCatalogueEntryIds,
      identity.scopes,
    );
    const published = await services.listPublishedModels();
    // Listing exposes ONLY published public aliases the caller is entitled to
    // (and in-scope for); the upstream agent id is never part of this
    // projection (see catalogue.listPublishedModels), and the internal
    // catalogue-entry id is dropped here before it can reach the client.
    const visible = published
      .filter((m) => authorized.has(m.catalogueEntryId))
      .map((m) => ({ id: m.id, created: m.created }));
    return reply.code(200).send(toModelList(visible));
  };
}

function handleChatCompletions(services: DataPlaneServices) {
  // S8 ordered authorization chain. INVARIANT: authentication + authorization +
  // quota all precede any upstream request; any denial ⇒ zero upstream calls.
  // Ordered steps:
  //   1. authenticate (401 on failure).
  //   2. parse/validate body (400 on failure).
  //   3. resolve entitlement; deny if no active subscription (403).
  //   4. compute the authorized catalogue-entry set (offerings ∩ PAT scopes).
  //   5. resolve the alias against the PUBLISHED catalogue (404 if unknown).
  //   6. authorize: a published model outside the caller's set is 404 (never
  //      reserves quota, never reveals the model exists).
  //   7. atomic quota reservation (429 on exhaustion).
  //   8. rewrite alias -> upstream agent id.
  //   9-11. dispatch upstream and pass the response through.
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const identity = await authenticateRequest(services, request, reply);
    if (!identity) return reply;
    const parsed = chatCompletionRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(invalidRequestBodyError());
    const entitlement = await services.resolveEntitlement(
      identity.organizationId,
    );
    if (!entitlement.active)
      return reply.code(403).send(noActiveSubscriptionError());
    // The caller's authorized catalogue-entry set (published is intersected
    // below at resolve time). Computed BEFORE any quota reservation.
    const authorized = authorizedCatalogueEntryIds(
      entitlement.entitledCatalogueEntryIds,
      identity.scopes,
    );
    // Resolve alias -> upstream agent BEFORE reserving quota so an unknown model
    // never burns a caller's budget. Only PUBLISHED aliases resolve.
    const resolved = await services.resolvePublishedAlias(parsed.data.model);
    if (!resolved) return reply.code(404).send(modelNotFoundError());
    // Authorization: a published model the caller is NOT entitled to (or that
    // its PAT scope excludes) is treated as NOT FOUND. Returning 404 rather than
    // 403 avoids enumeration — the proxy never reveals models outside the
    // caller's authorized set — and it happens BEFORE reserveQuota so an
    // unauthorized model never burns quota or reaches the upstream.
    if (!authorized.has(resolved.catalogueEntryId))
      return reply.code(404).send(modelNotFoundError());
    // Atomic reservation (CLAUDE.md rule 6). Fail closed: no upstream call when
    // the tenant is out of quota. A subsequent upstream failure does not refund
    // the unit (v1 accounting is best-effort; usage counts are not billed).
    const reservation = await services.reserveQuota(
      identity.organizationId,
      CHAT_QUOTA_COST,
    );
    if (!reservation.granted)
      return reply.code(429).send(insufficientQuotaError());
    // Rewrite the public alias to the upstream agent id; all other client fields
    // pass through so sampling controls still reach Sculpin.
    const upstreamPayload = { ...parsed.data, model: resolved.upstreamAgentId };
    const controller = new AbortController();
    // Propagate client disconnects so the upstream run is cancelled and the
    // stream is not buffered.
    request.raw.on("close", () => controller.abort());
    let upstreamResponse: Response;
    try {
      upstreamResponse = await services.upstream.chatCompletions(
        upstreamPayload,
        { requestHeaders: request.headers, signal: controller.signal },
      );
    } catch {
      // Never leak the internal URL, the key, or the underlying error.
      return reply.code(502).send(upstreamUnavailableError());
    }
    reply.code(upstreamResponse.status);
    for (const [name, value] of Object.entries(
      forwardableResponseHeaders(upstreamResponse.headers),
    ))
      reply.header(name, value);
    if (!upstreamResponse.body) return reply.send();
    // S9 alias rewrite: Sculpin echoes the internal upstream agent id in the
    // response body's protocol `model` field, which must NEVER leak to clients.
    // Rewrite it back to the caller-facing public alias (`parsed.data.model`).
    const contentType = upstreamResponse.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      // SSE: incremental transform preserving framing/ordering/backpressure and
      // rewriting ONLY the `model` field inside JSON `data:` events. Never buffer
      // the whole stream — events are forwarded as they arrive.
      const rewritten = (
        upstreamResponse.body as WebReadableStream<Uint8Array>
      ).pipeThrough(createSseModelRewriteStream(parsed.data.model));
      return reply.send(Readable.fromWeb(rewritten));
    }
    // Non-streaming JSON: the body is small/bounded, so buffering to rewrite the
    // `model` field is fine (the never-buffer rule applies only to SSE).
    const text = await upstreamResponse.text();
    return reply.send(rewriteModelInJsonBody(text, parsed.data.model));
  };
}

/**
 * Build the reviewed production route registry. This is the ONLY code that adds
 * routes to the default-DENY data plane, and it registers EXACTLY the two
 * OpenAI-compatible operations the Hub supports (CLAUDE.md rule 1). Routes are
 * never selected from environment or client input.
 */
export function createDataPlaneRouteRegistry(
  services: DataPlaneServices,
): RouteRegistry {
  return {
    routes: [
      { method: "GET", path: "/v1/models", handler: handleModels(services) },
      {
        method: "POST",
        path: "/v1/chat/completions",
        handler: handleChatCompletions(services),
      },
    ],
  };
}
