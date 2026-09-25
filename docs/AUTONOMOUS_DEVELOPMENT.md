# Autonomous feature development (Claude + Codex)

Authoritative policy for running bounded-autonomy feature work in this repository with the
`autonomous-development` Claude Code plugin (Claude orchestrates implementation; Codex
independently enhances, plans, and reviews). This policy is binding: where it constrains
autonomy it **overrides** any instinct to "just finish." When the gate cannot pass, report
**BLOCKED** — never fake completion.

## What the plugin is (and where it lives)

- Installed via the supported Claude Code plugin mechanism at **user scope** — it is **not**
  vendored into this repo. The controller and skills live in the plugin cache; do not copy,
  fork, or re-implement them here.
- Marketplace + plugin name are both `autonomous-development`
  (`SemanticMatter/autonomous-development`).
- Reinstall / update on a new machine:

  ```bash
  claude plugin marketplace add SemanticMatter/autonomous-development
  claude plugin install autonomous-development@autonomous-development
  ```

- The state-machine controller is at `${CLAUDE_PLUGIN_ROOT}/scripts/controller.py`.
  `CLAUDE_PLUGIN_ROOT` is exported by Claude Code when a plugin skill runs. For manual
  invocation, resolve it from `~/.claude/plugins/installed_plugins.json`.

## Prerequisites gate — `doctor` (non-negotiable, never bypass)

Before any autonomous work, the prerequisite gate MUST pass:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/controller.py" doctor
```

- Requires Python ≥ 3.11 (per the plugin's `pyproject.toml`), Git, and an **authenticated**
  Codex CLI. If ambient `python3` is older than 3.11, invoke with `python3.12`.
- The controller depends only on the Python standard library plus a bundled `jsonschema`; no
  extra `pip install` is required for the runtime.
- If `doctor` fails, **stop and fix the environment**. Do not silently bypass it, do not
  weaken it, and do not proceed to implementation on a red prerequisite gate.

## The mandated workflow loop

Every autonomous feature follows this loop; do not skip stages:

1. **Implementation** — Claude implements the slice.
2. **Verification** — run the repo checks via `run-check` (see below).
3. **Independent Codex review** — `controller.py codex --phase review`.
4. **Triage & fixes** — address findings; re-run affected checks.
5. **Re-verification** — checks green again.
6. **Re-review** — Codex re-review (and adversarial pass where warranted).
7. **Quality-gate acceptance** — `controller.py evaluate` (the sole authority; see below).

## Authoritative completion gate — `evaluate`

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/controller.py" evaluate
```

- `evaluate` is the **single, non-negotiable authority** on whether a feature is complete.
  A task is DONE only when `evaluate` reports success — not when Claude "thinks" it is done.
- Do **not** weaken tests, lint, types, security controls, or review criteria to force a pass.
- If `evaluate` cannot succeed, the outcome is **BLOCKED** with specifics — never a fake COMPLETE.

## Independent review — Codex phases

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/controller.py" codex --phase review
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/controller.py" codex --phase adversarial
```

- `--phase review`: standard independent review of the implemented change.
- `--phase adversarial`: adversarial pass — use for security-sensitive slices (PATs, the proxy
  data plane, upstream-credential handling, authz, quota decrement).
- Codex runs **read-only** (`--sandbox read-only`). It never edits, pushes, or deploys.

## Recording checks — `run-check`

All verification checks are recorded through the controller so `evaluate` can see them:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/controller.py" run-check --name <name> -- <cmd>
```

Repo-specific checks (this monorepo uses pnpm workspaces + Turborepo). When the ambient
pnpm/node engine mismatches (`ERR_PNPM_UNSUPPORTED_ENGINE`), use the direct-compiler fallbacks
from `CLAUDE.md`:

```bash
# Lint
run-check --name lint      -- pnpm lint
# Typecheck
run-check --name typecheck -- pnpm typecheck
# Unit tests (deterministic; no live Google/GitHub/Sculpin/Azure calls)
run-check --name unit      -- pnpm test
# Build
run-check --name build     -- pnpm build
# Integration tests (needs Compose Postgres: docker compose up -d postgres redis)
run-check --name integration -- pnpm test:integration
```

## Preferred entry point

Prefer the worktree-isolated workflow so `main`/feature branches stay clean:

```text
/autonomous-development:autonomous-feature "<feature description>"
```

Other workflows: `/autonomous-development:autonomous-current` (existing feature branch),
`/autonomous-development:autonomous-main` (opt-in direct edits), and
`/autonomous-development:autonomous-status`.

## Bounded-autonomy safety constraints (binding)

These sit **on top of** the "Non-negotiable security rules" in `CLAUDE.md` and apply to every
autonomous run:

- **Codex is read-only.** Never grant `danger-full-access`, `--yolo`, or any sandbox/permission
  bypass to Codex or to the workflow.
- **No autonomous push / merge / publish / deploy.** Do not alter remote infrastructure, rotate
  or expose credentials, or apply irreversible production migrations.
- **Prefer isolated worktrees.** Do not delete or overwrite unrelated user changes.
- **Do not create commits unless explicitly requested.** Current-checkout modes never commit and
  require a clean tree.
- **The Sculpin upstream (`/home/thomas/project/semanticmatter/sculpin`) is READ-ONLY.**
- **Never bypass a failed `doctor`.** Never weaken checks to force `evaluate` to pass.
- Imported-PR reviews are read-only and cannot run local `run-check`.

## Non-destructive smoke test

To validate the integration without mutating repo state or creating runs:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/controller.py" doctor
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/controller.py" --help
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/controller.py" list-runs
```

## Final-state reporting

An autonomous run reports exactly one of:

- **COMPLETE** — only if `controller.py evaluate` succeeded on an un-weakened quality gate.
- **BLOCKED** — with specific, actionable detail on what prevented the gate from passing.
