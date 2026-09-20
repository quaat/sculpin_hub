import {
  parseDiscoveredAgents,
  type DiscoveredAgent,
} from "@sculpin/domain";
import { parseDiscoveryConfig, type DiscoveryConfig } from "@sculpin/config";
import { requireAdmin, type AuthzDeps } from "./session";

/**
 * S5 server-side Sculpin discovery boundary (CLAUDE.md rules 3, 4, 5).
 *
 * SERVER-ONLY. This module transitively imports `./session` (which reads
 * `next/headers`) and reads `process.env` / a Sculpin credential, so it must
 * never be bundled into the browser. There is no `"use client"` here and it is
 * only imported by server code (S6 admin route handlers / server actions).
 *
 * This is the ONLY place that reads the discovery URL/key and calls Sculpin's
 * OpenAI `GET /v1/models`. Mirroring `apps/proxy/src/upstream.ts`'s discipline it:
 *  - injects `Authorization: Bearer <SCULPIN_DISCOVERY_API_KEY>` and forwards NO
 *    caller credential (no cookies, no session, no PAT) upstream;
 *  - never returns, logs, or otherwise exposes the internal URL or the key —
 *    upstream failures are surfaced as a sanitized, secret-free error;
 *  - accepts an injected `fetch` so tests never make a live Sculpin call.
 *
 * Every call is gated by `requireAdmin`, which re-derives the platform role from
 * the canonical `users` row (never the session), so only a live, active admin
 * can trigger a discovery call.
 */

export type DiscoveryFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

/**
 * Stable, secret-free failure surfaced when discovery cannot complete. Carries a
 * machine `reason` and NEVER the upstream URL, key, or response body — so callers
 * (and any error page) can render it without leaking the credential boundary.
 */
export class DiscoveryError extends Error {
  readonly reason: "discovery_upstream_unavailable" | "discovery_upstream_malformed";
  constructor(
    reason: "discovery_upstream_unavailable" | "discovery_upstream_malformed",
  ) {
    super(reason);
    this.name = "DiscoveryError";
    this.reason = reason;
  }
}

export interface DiscoveryDeps {
  readonly authz?: Partial<AuthzDeps>;
  /** Injected for tests; defaults to the validated deployment config. */
  readonly config?: DiscoveryConfig;
  /** Injected for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: DiscoveryFetch;
  /** Bound on how long a discovery call may run before failing closed. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

function resolveConfig(config?: DiscoveryConfig): DiscoveryConfig {
  return config ?? parseDiscoveryConfig(process.env);
}

/**
 * Discover the current set of Sculpin upstream agents (admin-only).
 *
 * Returns the parsed {@link DiscoveredAgent} rows from Sculpin's `GET /v1/models`
 * (see the domain module for the deliberate no-pairing / STABLE-ALIAS rule).
 * Fails closed on any non-200, network error, timeout, or malformed body,
 * throwing a {@link DiscoveryError} whose message is only a machine reason — the
 * upstream URL, key, and body never appear in the thrown error or return value.
 */
export async function discoverSculpinAgents(
  deps?: DiscoveryDeps,
): Promise<readonly DiscoveredAgent[]> {
  // Authorize FIRST (fail closed on authz before touching any credential).
  await requireAdmin(deps?.authz);
  const config = resolveConfig(deps?.config);
  const fetchImpl = deps?.fetchImpl ?? (fetch as unknown as DiscoveryFetch);
  const base = config.sculpinUpstreamUrl.replace(/\/+$/, "");
  const timeoutMs = deps?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(`${base}/v1/models`, {
      method: "GET",
      headers: {
        // Terminate any ambient identity; inject the least-privilege discovery
        // credential here and nowhere else. No caller cookies/PAT are forwarded.
        authorization: `Bearer ${config.sculpinDiscoveryApiKey}`,
        accept: "application/json",
      },
      signal: controller.signal,
    });
  } catch {
    // Network error / abort / timeout — never surface the cause (may embed URL).
    throw new DiscoveryError("discovery_upstream_unavailable");
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    // Do NOT read or surface the body; it could echo upstream identity.
    throw new DiscoveryError("discovery_upstream_unavailable");
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new DiscoveryError("discovery_upstream_malformed");
  }

  try {
    return parseDiscoveredAgents(body);
  } catch {
    // Domain validation error — re-map to a sanitized reason (the domain error
    // message is already secret-free, but keep the discovery surface uniform).
    throw new DiscoveryError("discovery_upstream_malformed");
  }
}

export type { DiscoveredAgent };
