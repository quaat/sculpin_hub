---
description: Rules for tests — determinism, no live external calls, fake Sculpin upstream, and required negative-security assertions.
globs:
  - "**/*.test.ts"
  - "**/*.integration.test.ts"
---

# Testing rules

Applies to: all test files (`**/*.test.ts`, `**/*.integration.test.ts`) and test harnesses.

## Determinism (CLAUDE.md working style)
- The deterministic suite MUST be free of live external calls: no Google, GitHub, real Sculpin, or Azure. Use test doubles and a FAKE Sculpin upstream that mirrors `docs/SCULPIN_INTEGRATION.md`.
- Stock OpenAI client is the correct caller for E2E proxy tests — do not roll a bespoke client that hides framing bugs.

## Integration harness
- Integration suites are `*.integration.test.ts`, discovered by the runner. The runner creates a temporary DB, deploys Prisma migrations, disables Vitest file parallelism, and drops the DB in `finally`.
- Run with `pnpm test:integration` (needs Compose Postgres: `docker compose up -d postgres redis`). On engine mismatch invoke the vitest/tsc binaries directly per CLAUDE.md.

## Required negative-security assertions (these must exist and pass)
- Proxy: unregistered `/v1/*` is DENIED; caller PAT/cookies/`Authorization` are NOT forwarded upstream; the internal Sculpin URL never appears in any client-visible surface; the upstream key never appears in responses/logs/usage events.
- SSE: framing preserved (`data: <json>\n\n`, `: keep-alive\n\n`, `data: [DONE]`) with event ordering and backpressure via the fake upstream; the incremental transform rewrites ONLY the internal model id inside JSON `data:` events to the public alias (not byte-for-byte); no whole-stream buffering; client disconnect propagates. The non-streaming path likewise rewrites the body's `model` field.
- PAT: DB contents are NOT usable as bearer creds; logs contain no token values; revoked/expired PATs are rejected; verification is constant-time.
- Quota: atomic trial reservation proven under CONCURRENCY at the last unit (no over-grant).
- OAuth: linking is provably off; every user has a personal org (invariant query).

## Hygiene
- Tests must not log secrets, tokens, prompts, or response bodies. Clean up temp DBs/resources in `finally`.
