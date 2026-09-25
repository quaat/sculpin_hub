# AGENT.md — Orchestration guide for Sculpin Hub

How the lead agent (orchestrator) and sub-agents collaborate on this project.

## Roles

- **Orchestrator (main session):** owns global architecture, decomposes work into milestones,
  delegates to sub-agents, reconciles their output, and verifies before declaring a milestone
  complete. Does NOT implement the entire system in one uncontrolled pass.
- **Sub-agents:** scoped investigation, implementation, review, testing, or security tasks.
  Spawn with `model: "opus"`. Never hardcode a versioned model id (it will go stale).

## Delegation rules

- Give each sub-agent a **self-contained** brief: goal, why it matters, constraints, exact
  paths, and the expected deliverable. Sub-agents do not see this conversation.
- Reserve sub-agents for parallelizable investigation, protecting the main context from large
  outputs, and independent implementation slices. Don't duplicate a sub-agent's work.
- For security-sensitive slices (PATs, proxy, upstream credential), commission a dedicated
  **security review** sub-agent before marking done.
- **Trust but verify:** a sub-agent's summary is intent, not proof. Inspect the actual files
  it wrote before accepting the result.

## Sandbox caveat (important)

The default sandbox masks `/home/thomas/**` as char-device placeholders. A sub-agent that
cannot read a path may wrongly report it "does not exist" (this happened once for the Sculpin
upstream — a false negative). Reading the Sculpin upstream is now allow-listed in
`.claude/settings.local.json`. Instruct investigation agents to `ls -la` the target first and
confirm real files before drawing conclusions; the orchestrator can use
`dangerouslyDisableSandbox` to verify ground truth.

## Milestone flow

See `docs/IMPLEMENTATION_PLAN.md` for the milestone list and `docs/STATUS.md` for live state.
Order: M0 discovery → M1 scaffold → M2 identity/OAuth → M3 catalogue → M4 plans/subscriptions
→ M5 PATs (security review) → M6 OpenAI proxy → M7 usage/analytics → M8 Azure deploy →
M9 verification. M6 proxy architecture must NOT be frozen before M0 (`SCULPIN_INTEGRATION.md`)
is complete.

## Autonomous feature development (Claude + Codex)

Bounded-autonomy feature work runs under the `autonomous-development` plugin. See
`docs/AUTONOMOUS_DEVELOPMENT.md` for the binding policy. The loop is implementation →
verification → independent Codex review → triage/fixes → re-verify → re-review → quality-gate
acceptance. `controller.py doctor` is the prerequisite gate (never bypass); `controller.py
evaluate` is the sole completion authority (never weaken checks to force a pass). Codex is
read-only; no autonomous push/merge/deploy; prefer worktrees; don't commit unless asked.
Prefer `/autonomous-development:autonomous-feature`. Report **COMPLETE** (only on a genuine
`evaluate` success) or **BLOCKED**.

## Guardrails every agent inherits

The security rules in `CLAUDE.md` ("Non-negotiable security rules") apply to all agents. The
Sculpin upstream is read-only. Never log or persist secrets. Fail closed.
