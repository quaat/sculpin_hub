import type { DataPlaneConfig } from "@sculpin/config";

/**
 * Centralized upstream-credential boundary (CLAUDE.md rules 3, 4).
 *
 * This is the ONLY module that reads `sculpinUpstreamUrl` /
 * `sculpinUpstreamApiKey` and constructs a request to Sculpin. It:
 *  - injects `Authorization: Bearer <SCULPIN_UPSTREAM_API_KEY>` and NEVER
 *    forwards the caller's PAT, cookies, or `Authorization`;
 *  - forwards only an explicit allowlist of safe request headers;
 *  - never returns, logs, or otherwise exposes the internal URL or the key;
 *  - accepts an injected `fetch` so tests never make live calls.
 */

// RFC 7230 hop-by-hop headers — never forwarded in either direction.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-authorization",
  "proxy-authenticate",
]);

// Request headers the Hub is willing to relay upstream. `authorization`,
// `cookie`, and any PAT-bearing header are deliberately absent: the caller's
// credentials are terminated here and replaced with the Hub's upstream key.
const FORWARDABLE_REQUEST_HEADERS = new Set([
  "x-exodus-conversation-id",
  "x-agent-platform-include-metadata",
]);

// Response headers the Hub relays back to the caller. Anything not on this list
// (including hop-by-hop, `server`, `x-powered-by`, or any header that could
// reveal upstream identity) is dropped.
const FORWARDABLE_RESPONSE_HEADERS = new Set([
  "content-type",
  "x-exodus-conversation-id",
  "x-exodus-conversation-reused",
  "x-exodus-conversation-source",
]);

export type FetchLike = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export interface UpstreamRequestOptions {
  /** Raw incoming request headers; only the safe allowlist is relayed. */
  readonly requestHeaders: Readonly<
    Record<string, string | string[] | undefined>
  >;
  /** Aborted when the client disconnects so the upstream run is cancelled. */
  readonly signal: AbortSignal;
}

export interface SculpinUpstream {
  chatCompletions(
    payload: unknown,
    options: UpstreamRequestOptions,
  ): Promise<Response>;
}

function safeForwardHeaders(
  requestHeaders: Readonly<Record<string, string | string[] | undefined>>,
): Headers {
  const headers = new Headers();
  for (const [name, raw] of Object.entries(requestHeaders)) {
    const lower = name.toLowerCase();
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(lower)) continue;
    if (!FORWARDABLE_REQUEST_HEADERS.has(lower)) continue;
    headers.set(lower, value);
  }
  return headers;
}

/**
 * Project an upstream response's headers onto the caller-safe allowlist. Never
 * relays hop-by-hop headers or anything that could identify the upstream.
 */
export function forwardableResponseHeaders(
  responseHeaders: Headers,
): Record<string, string> {
  const out: Record<string, string> = {};
  responseHeaders.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) return;
    if (!FORWARDABLE_RESPONSE_HEADERS.has(lower)) return;
    out[lower] = value;
  });
  return out;
}

export function createSculpinUpstream(
  config: Pick<DataPlaneConfig, "sculpinUpstreamUrl" | "sculpinUpstreamApiKey">,
  fetchImpl: FetchLike = fetch,
): SculpinUpstream {
  // Normalize once so a trailing slash never produces `//v1`.
  const base = config.sculpinUpstreamUrl.replace(/\/+$/, "");
  return {
    async chatCompletions(payload, options) {
      const headers = safeForwardHeaders(options.requestHeaders);
      headers.set("content-type", "application/json");
      // Terminate the caller credential; inject the Hub's upstream key here and
      // nowhere else.
      headers.set("authorization", `Bearer ${config.sculpinUpstreamApiKey}`);
      return fetchImpl(`${base}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: options.signal,
      });
    },
  };
}
