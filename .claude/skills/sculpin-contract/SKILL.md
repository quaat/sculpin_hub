---
name: sculpin-contract
description: Use to check or refresh the Hub's understanding of the upstream Sculpin OpenAI-compat contract (routes, auth, model mapping, SSE, headers) without running or modifying Sculpin.
---

# sculpin-contract

Reference and re-verify the upstream Sculpin `/v1` contract. Sculpin is READ-ONLY — never modify, run, or write to it.

## When to use
Designing/reviewing the proxy or catalogue, or when a proxy test fails against the fake upstream and you need the ground-truth contract.

## Source of truth
`docs/SCULPIN_INTEGRATION.md` (M0 discovery). Upstream repo at `/home/thomas/project/semanticmatter/sculpin` is allow-listed for READING only. If a path shows char-device placeholders, that is sandbox masking — `ls -la` first; do NOT conclude a file is missing.

## Contract essentials
- **Routes to allow:** `GET /v1/models`, `POST /v1/chat/completions`. DENY `/v1/api-keys` and native `/api/v1/*`. No upstream `/v1/embeddings` or `/v1/completions`.
- **Auth:** upstream expects `Authorization: Bearer <key>`; env var `OPENAI_COMPAT_DEV_API_KEY`. The Hub injects its own upstream key and never copies Sculpin's outbound `OPENAI_API_KEY`.
- **Model mapping:** OpenAI `model` = agent slug OR UUID; public alias → agent (single shared upstream credential in v1, D-008); model listing is tenant-scoped.
- **SSE framing:** `data: <json>\n\n`; keepalive `: keep-alive\n\n`; terminal `data: [DONE]\n\n`. Pass through byte-for-byte; propagate disconnect.
- **Headers:** pass through `X-Exodus-Conversation-Id`/`-Reused`/`-Source`; strip hop-by-hop; metadata via `X-Agent-Platform-Include-Metadata`.
- **Caveats:** `usage` is a heuristic (do NOT meter on it, D-007); `finish_reason` always `stop`; sampling fields accepted but ignored.

## Fake upstream
The deterministic test fake MUST mirror the above framing/headers so tests catch real drift. Never call the real Sculpin in the deterministic suite.
