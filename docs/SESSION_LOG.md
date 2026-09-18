# Sculpin Hub — Session Log

Chronological log of significant work sessions, so a future session can pick up context that
isn't derivable from git history alone. Keep entries short.

## 2026-09-17 — Mission kickoff & Milestone 0

- Confirmed the real codebase is `sculpin_hub` (underscore); the sibling `sculpin-hub` (hyphen)
  is empty. (D-001)
- Diagnosed why a prior Sculpin investigation sub-agent reported a false negative: the default
  sandbox masks `/home/thomas/**`. Staged a sandbox read-allow for the read-only upstream in
  `.claude/settings.local.json` and had the user relaunch from `sculpin_hub`. (D-002)
- Added Foundry model constants (`packages/config/src/models.ts` +
  `export * from "./models.js"`) for `claude-opus-5`, `claude-fable-5`. Typecheck + lint clean.
- **M0:** launched an Opus sub-agent to investigate the upstream and produce
  `SCULPIN_INTEGRATION.md` (route inventory, auth, base URL, model↔agent map, streaming).
- **M1:** created durable scaffolding — CLAUDE.md, AGENT.md, docs/IMPLEMENTATION_PLAN.md,
  STATUS.md, DECISIONS.md, THREAT_MODEL.md, DEPLOYMENT.md, OPERATIONS.md, and this log.
- Recorded that the current mission supersedes the long-form plan on identity (Google/GitHub,
  not LinkedIn) and billing (no payments in v1). (D-004)
- **M0 completed:** sub-agent confirmed Sculpin exists (no repeat false negative) and documented
  the OpenAI surface — `agent-api:8001`, `GET /v1/models` + `POST /v1/chat/completions`, bearer
  auth via `OPENAI_COMPAT_DEV_API_KEY`, SSE framing, native `/api/v1/*` to be denied. Derived
  proxy route policy (D-006), the "don't trust upstream usage" constraint (D-007), and flagged
  the unresolved Sculpin tenant-mapping decision for the user (DECISIONS OPEN).
