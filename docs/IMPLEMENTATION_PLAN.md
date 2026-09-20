# Sculpin Hub — Milestone Tracker

This is the **authoritative milestone-level execution tracker**. Together with
[`DECISIONS.md`](DECISIONS.md), the ADRs in [`adr/`](adr/), [`STATUS.md`](STATUS.md), and the
security rules in [`../CLAUDE.md`](../CLAUDE.md), it is the source of truth for what the Hub
builds. The long-form
[`sculpin-knowledge-hub-implementation-plan.md`](sculpin-knowledge-hub-implementation-plan.md)
(generated from [`../plan.md`](../plan.md)) is **historical/superseded** background — it
references LinkedIn/Stripe, which v1 does not use; where it conflicts, this tracker and the
decision log win. This file records the orchestration milestones the lead agent executes and
their acceptance criteria. Live status is in [`STATUS.md`](STATUS.md).

> **Scope note / divergence:** the long-form plan predates the current mission and references
> Google/**LinkedIn** login and **Stripe** billing. The current mission supersedes those:
> identity is Google/**GitHub**, and there are **no payments in v1** (trial + commercial
> subscriptions without a payment provider). See [`DECISIONS.md`](DECISIONS.md#d-004).

## Milestones

| ID  | Milestone                                                                       | Depends on | Status                       |
| --- | ------------------------------------------------------------------------------- | ---------- | ---------------------------- |
| M0  | Sculpin upstream discovery → `SCULPIN_INTEGRATION.md` + route policy inputs     | —          | ✅ complete                  |
| M1  | Durable scaffolding (this doc set, CLAUDE.md, AGENT.md, skills)                 | —          | ✅ complete                  |
| M2  | Identity & OAuth (Google/GitHub), sessions, roles, admin bootstrap              | M0, M1     | ✅ complete (live-verified)  |
| M3  | Sculpin catalogue: admin-published knowledge bases/agents, public model aliases | M0, M2     | ✅ core (review pending)     |
| M4  | Plans & subscriptions (trial + commercial, NO payments), entitlements           | M2, M3     | ✅ core (review pending)     |
| M5  | Personal Access Tokens lifecycle (+ dedicated security review)                  | M2, M4     | ✅ core (review pending)     |
| M6  | OpenAI-compatible proxy / broker (fail-closed registry, streaming)              | M0, M5     | ✅ core (review PASS)        |
| M7  | Usage metering, quota reservation, analytics/audit                              | M4, M6     | ⏳ quota + per-request usage events done (S13/D-023); analytics/audit surfaces next |
| M8  | Azure deployment (Key Vault, managed identity, IaC)                             | M6         | pending                      |
| M9  | Complete verification (security, E2E, ops readiness)                            | all        | ⏳ browser/control-plane E2E harness landed (S15/D-024, CI-run); security reviews + ops readiness pending |

## Acceptance criteria (per milestone)

- **M0:** Route inventory table of every real Sculpin `/v1/*` endpoint; auth mechanism + env
  var name; base URL/port; model↔agent mapping; streaming/SSE framing; open questions listed.
  No upstream files modified.
- **M1:** CLAUDE.md, AGENT.md, STATUS.md, DECISIONS.md, SESSION_LOG.md, THREAT_MODEL.md,
  DEPLOYMENT.md, OPERATIONS.md present and cross-referenced; harmonized with existing ADRs.
- **M2:** OAuth (Google/GitHub) with state/nonce/PKCE, redirect allowlist, secure cookies,
  no unsafe email-based linking; USER/ADMIN roles; `BOOTSTRAP_ADMIN_EMAILS`. ADR 004 resolved.
- **M3:** Admins publish/unpublish catalogue entries; public model alias → upstream agent id
  map; internal Sculpin config never leaked to clients.
- **M4:** Subscription state machine; entitlement resolution as union of active subscriptions;
  atomic trial quota reservation. No payment provider.
- **M5:** PAT `sclp_pat_<id>_<secret>`, HMAC-SHA-256 keyed digest, one-time display, constant-
  time verify, revocation prompt. Tests prove DB contents aren't usable as bearer creds and
  logs contain no token values. Security review passed.
- **M6:** Default-DENY `/v1/*` registry; only confirmed Sculpin routes registered; upstream
  credential injection centralized; SSE relayed incrementally with framing/ordering preserved but the
  internal agent id rewritten to the public alias (NOT byte-for-byte, S9) and fail-closed on a
  malformed event; no PAT/cookie/Authorization forwarded upstream; no internal URL leaked.
- **M7:** Usage events without secrets/prompts/bodies (DONE, S13/D-023: one `usage_events` row per
  granted reservation, written atomically in the same transaction as the quota UPDATE; none on
  denial); atomic quota under concurrency (tested at last-quota, incl. usage-rows == granted-count);
  analytics/audit READ surfaces still to come.
- **M8:** Secrets via Key Vault + managed identity; no secrets in IaC; private connectivity to
  Sculpin considered.
- **M9:** Full security review, E2E flows, ops runbook, SLOs, rollback verified. Live manual
  E2E path (Hub ⇄ real Sculpin ⇄ OpenAI client / Open WebUI) documented in
  [`LIVE_E2E_RUNBOOK.md`](LIVE_E2E_RUNBOOK.md); Connect page ships copy-paste client snippets.

## Guardrails

All milestones inherit the fail-closed security rules in [`../CLAUDE.md`](../CLAUDE.md) and the
read-only Sculpin upstream constraint. Verify before marking complete.
