---
name: hub-milestone
description: Use when starting, decomposing, or closing a Sculpin Hub milestone/phase — enforces the orchestration flow, dependencies, and per-milestone acceptance gates.
---

# hub-milestone

Guide the orchestrator through a milestone or phase in `docs/IMPLEMENTATION_PLAN.md` and `docs/NEXT_PHASE_PLAN.md`.

## When to use
Starting a new milestone/phase, splitting it into sub-agent briefs, or verifying it before marking complete.

## Flow
1. Read `docs/IMPLEMENTATION_PLAN.md` (milestone table + acceptance), `docs/NEXT_PHASE_PLAN.md` (phases A–D), and `docs/STATUS.md` (live state).
2. Confirm dependencies are satisfied: M0→M1→M2→M3→M4→M5→M6→M7→M8→M9. Never freeze M6 proxy design before M0 (`docs/SCULPIN_INTEGRATION.md`) is complete.
3. Decompose into self-contained sub-agent briefs (goal, why, constraints, exact paths, deliverable). Spawn sub-agents with `model: "opus"` — never a versioned id. Route to the right owner agent:
   - identity → identity-security-implementer; schema/domain → database-domain-implementer; catalogue → catalogue-implementer; plans → subscription-implementer; PATs → pat-security-implementer; proxy → proxy-data-plane-implementer; UI → frontend-product-implementer; E2E → e2e-integration-implementer.
4. For security-sensitive slices (M5 PATs, M6 proxy, credential injection) commission security-reviewer before done; for M6/M3 also run integration-reviewer against the Sculpin contract.
5. Verify against the milestone's acceptance criteria. Trust-but-verify: inspect the actual files a sub-agent wrote, not just its summary. Then update `docs/STATUS.md` and the milestone table (respect documentation-consistency rule).

## Gates
- All work inherits CLAUDE.md fail-closed rules and the read-only Sculpin constraint.
- Small, reviewable slices; do not implement the whole system in one pass.
