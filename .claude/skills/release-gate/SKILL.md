---
name: release-gate
description: Use as the final pre-merge/pre-release checklist for a milestone — runs typecheck/lint/tests, verifies fail-closed invariants, and confirms docs/status are consistent.
---

# release-gate

Final gate before merging a milestone or cutting a release. Fail closed: if any item is unverified, do NOT pass.

## When to use
Closing a milestone/phase, opening a release PR, or after a security-sensitive slice.

## Build & test
1. Typecheck: `pnpm typecheck` (or `node node_modules/typescript/bin/tsc -p <pkg>/tsconfig.json --noEmit` per package on engine mismatch).
2. Lint: `pnpm lint` (or `node node_modules/eslint/bin/eslint.js <path>` on engine mismatch).
3. Tests: `pnpm test` (deterministic, no live external calls) and `pnpm test:integration` (needs Compose Postgres).
4. Deterministic E2E: `pnpm test:e2e` (stock OpenAI client against a FAKE Sculpin upstream; no live calls).
5. Browser/control-plane E2E (Playwright) for the user + admin journeys.
6. A secret scan of the working tree/diff.
7. `git diff --check` (no whitespace errors / conflict markers).
8. `pnpm build` and `pnpm env:smoke`.

## Fail-closed invariant checks
- Proxy default-DENY: production registry empty; only the two real `/v1` routes registered; no blind forwarder. (See proxy-security-review.)
- PATs: only HMAC digest stored; no token in logs/DB; constant-time verify; revocation immediate.
- Upstream credential: single injection module; never in DB/logs/usage/errors/responses; internal URL never leaked; hop-by-hop stripped.
- OAuth: state/nonce/PKCE, redirect allowlist, secure cookies, `accountLinking.enabled = false`; server-side USER/ADMIN authz; auditable admin bootstrap.
- Quota atomic under concurrency; usage events free of secrets/prompts/bodies.
- `.env.example` names/docs only, no secrets; startup env validation present.

## Docs & status
- Milestone status in `docs/IMPLEMENTATION_PLAN.md`/`docs/STATUS.md` matches code reality; recorded decisions honored (documentation-consistency rule); cross-links resolve.

## Sign-off
Security-sensitive slices require a passing security-reviewer (and integration-reviewer for M3/M6). Record the outcome and any residual risks in `docs/STATUS.md` / `docs/DECISIONS.md`.
