---
name: proxy-security-review
description: Use to run the fail-closed security checklist over the proxy data plane and upstream-credential injection before shipping M6 or any /v1 change.
---

# proxy-security-review

Audit the data plane against CLAUDE.md rules 1/3/4/5 and D-006. Read-only mindset; report findings.

## When to use
Before marking M6 / Phase A done, or after any change under `apps/proxy/src/**` or the credential-injection module.

## Checklist
1. **Default-DENY:** `emptyProductionRouteRegistry()` returns an empty frozen list; production server uses it. Only `GET /v1/models` and `POST /v1/chat/completions` are registered, via reviewed code only — grep for env/client-driven route selection (must find none). No blind forwarder (`forward.ts`) or `/v1/*` catch-all remains in `server.ts`.
2. **Credential injection:** one module owns it; caller `Authorization`/cookies/PAT are stripped, not forwarded; `Authorization: Bearer ${SCULPIN_UPSTREAM_API_KEY}` is set from validated config. Grep logs/usage/errors/responses for the upstream key (must find none).
3. **No SSRF / URL leak:** upstream base URL from validated config only; internal Sculpin URL never in any client surface.
4. **Header hygiene:** hop-by-hop headers stripped (`Connection, Keep-Alive, Transfer-Encoding, TE, Trailer, Upgrade, Proxy-Authorization, Proxy-Authenticate`); inbound `X-Exodus-Conversation-*` and `X-Agent-Platform-Include-Metadata` NOT forwarded upstream, upstream conversation headers NOT returned to clients (conversation isolation).
5. **SSE:** incremental transform preserves framing (`data: <json>\n\n`, `: keep-alive\n\n`, `data: [DONE]`), event ordering, and backpressure, rewriting ONLY the internal model id inside JSON `data:` events to the public alias (not byte-for-byte); non-streaming path rewrites the body's `model` field; no whole-stream buffering; disconnect propagates.
6. **Logging/limits:** no body logging; `PROXY_BODY_LIMIT_BYTES`, timeouts, bounded shutdown enforced.

## Verify
Run `apps/proxy` unit + `server.test.ts` (vitest) against the FAKE upstream. Confirm tests assert: unregistered `/v1/*` denied, no caller-cred forwarding, no URL leak, SSE framing.

## Output
HIGH/MED/LOW findings with file:line + impact; explicit PASS or BLOCKED; assumptions + unresolved risks.
