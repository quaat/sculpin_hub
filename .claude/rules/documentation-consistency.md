---
description: Rules for keeping docs, decisions, status, and env examples consistent with the code and with each other.
globs:
  - "docs/**"
  - "*.md"
  - ".env.example"
---

# Documentation consistency

Applies to: `docs/**`, top-level `*.md` (CLAUDE.md, AGENT.md), and `.env.example`.

Load when editing docs or when a code change alters a documented claim.

## Status must match code
- Do not mark a milestone complete in `docs/IMPLEMENTATION_PLAN.md` / `docs/STATUS.md` unless the code proves it (e.g. do NOT claim M6 done while the blind forwarder exists or the registry is empty).
- When code changes a behavior a doc describes, update the doc in the same change or flag the drift.

## Honor recorded decisions
- Reflect and never silently contradict: default-DENY registry & route policy (D-006), PAT HMAC storage (D-005), `accountLinking.enabled = false` (D-012), atomic provisioning (D-011), single shared upstream credential (D-008), no payment provider / Google+GitHub not LinkedIn (D-004), do-not-meter-on-upstream-usage (D-007).
- Architecture-grade decisions belong in `docs/adr/`; lighter/in-flight ones in `docs/DECISIONS.md`. Mark superseded decisions as such.

## Cross-references & divergence notes
- Keep cross-doc links resolvable (no dead links). Preserve the divergence note that the mission supersedes the long-form plan (Google/GitHub, no Stripe).

## Env docs & secrets (rule 8)
- `.env.example` contains variable NAMES and DOCS only — NEVER real secrets. It must match startup env validation.
- Production secrets are documented as coming from Azure Key Vault + managed identity; never commit secrets to IaC or docs.

## Threat model
- `docs/THREAT_MODEL.md` controls must still map to real code controls; update it when a boundary or control changes.
