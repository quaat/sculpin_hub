---
description: Fail-closed rules for the OpenAI-compatible proxy data plane and upstream credential handling.
globs:
  - "apps/proxy/**"
---

# Proxy & upstream-credential security

Applies to: `apps/proxy/**` (and any module that injects the upstream credential or registers `/v1/*` routes).

These are conditional, detail-heavy expansions of CLAUDE.md rules 1, 3, 4, 5 and D-006 — load them when touching the data plane.

## Default-DENY registry (rule 1)
- The production registry `apps/proxy/src/registry.ts` MUST start empty (`emptyProductionRouteRegistry`).
- Register routes ONLY through reviewed code. NEVER select routes from env vars, config, request bodies, headers, or any client/admin input.
- Register EXACTLY these upstream routes and no others (D-006): `GET /v1/models`, `POST /v1/chat/completions`.
- DENY Sculpin's `/v1/api-keys` (GET/POST/DELETE) and the entire native `/api/v1/*` back-office API. `/v1/embeddings` and `/v1/completions` have no upstream — return an OpenAI-shaped `unsupported`/404.
- Any unregistered `/v1/*` path returns the fail-closed OpenAI-shaped error; never a pass-through.
- Delete/keep-deleted the dev-only blind forwarder (`forward.ts`) and its catch-all wiring; it violates rules 1/3/4.

## Credential injection (rules 3, 4)
- Centralize ALL upstream-credential handling in ONE module.
- NEVER forward the caller's `Authorization`, cookies, or PAT upstream. Strip them.
- Set `Authorization: Bearer ${OPENAI_COMPAT_DEV_API_KEY}` (the Hub's upstream key) from validated config only.
- The upstream key NEVER touches the DB, browsers, logs, usage events, error pages, or API responses.
- Upstream base URL comes from validated config ONLY — no client/admin-supplied target (no SSRF). The internal Sculpin URL is NEVER returned to clients.
- Strip hop-by-hop headers: `Connection, Keep-Alive, Transfer-Encoding, TE, Trailer, Upgrade, Proxy-Authorization, Proxy-Authenticate`. Pass through `X-Exodus-Conversation-*`.

## Streaming (SSE)
- When `stream: true`, pass through byte-for-byte: `data: <json>\n\n`, keepalive `: keep-alive\n\n`, terminal `data: [DONE]`.
- Do NOT buffer the stream; forward bytes as they arrive; propagate client disconnects to cancel the upstream run.

## Logging & limits (rule 5)
- No request/response body logging by default. Never log tokens, prompts, or responses.
- Enforce `PROXY_BODY_LIMIT_BYTES`, request timeouts, and bounded shutdown.

## Required tests before done
- Unit + `server.test.ts` proving: unregistered `/v1/*` denied; caller PAT/cookie/Authorization not forwarded; no internal URL in any client surface; SSE framing intact. Use a FAKE Sculpin upstream — never the real one.
