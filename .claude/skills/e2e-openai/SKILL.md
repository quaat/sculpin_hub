---
name: e2e-openai
description: Use to build or run the deterministic end-to-end flow — signed-in user mints a PAT and drives /v1 with a stock OpenAI client against a fake Sculpin — with all negative-security assertions.
---

# e2e-openai

Prove the target scenario deterministically: sign-in-provisioned user → mint PAT → stock OpenAI client → Hub `/v1` → FAKE Sculpin (including streaming).

## When to use
Building the E2E suite, or verifying Phase A + Phase B together (the minimum viable real test).

## Setup
- Caller: a STOCK OpenAI client pointed at the Hub `/v1` base URL, PAT as the API key.
- Upstream: a FAKE Sculpin that mirrors `docs/SCULPIN_INTEGRATION.md` framing/headers. NO live Google/GitHub/Sculpin/Azure calls.
- DB: integration runner creates a temp DB, deploys Prisma migrations, disables Vitest file parallelism, drops the DB in `finally`. Needs `docker compose up -d postgres redis`.

## Flow to assert
1. User provisioned with a personal org on first sign-in (test double for OAuth).
2. Mint a PAT `sclp_pat_<id>_<secret>`; secret shown once.
3. Stock client calls `GET /v1/models` and `POST /v1/chat/completions` (non-stream + `stream:true`).
4. Hub authenticates the PAT, authorizes (entitlement), meters, and proxies.

## Negative-security assertions (must pass)
- Unregistered `/v1/*` → fail-closed error.
- Caller PAT/cookies/`Authorization` NOT forwarded upstream (inspect fake upstream's received headers).
- Internal Sculpin URL + upstream key never in any client-visible surface, log, or usage event.
- SSE framing preserved (`data: <json>\n\n`, `: keep-alive\n\n`, `data: [DONE]`) with event ordering and backpressure; the incremental transform rewrites ONLY the internal model id to the public alias (not byte-for-byte), and the non-streaming path rewrites the body's `model` field; disconnect propagates.
- Revoked/expired PAT rejected; trial quota atomic under concurrency at the last unit.

## Run
`pnpm test` (deterministic) and `pnpm test:integration`. On engine mismatch invoke vitest/tsc binaries directly per CLAUDE.md.
