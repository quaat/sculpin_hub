---
description: Rules for the web control plane — OAuth/session/authz, admin bootstrap, PAT UI, and no-secret-in-browser hygiene.
globs:
  - "apps/web/**"
---

# Web control plane (identity, authz, UI)

Applies to: `apps/web/**`.

Conditional expansions of CLAUDE.md rules 2, 7 and D-004/D-011/D-012 — load when touching web auth, admin, or credential UI.

## OAuth & sessions (rule 7, D-012)
- Providers are Google + GitHub ONLY (D-004). Use state/nonce/PKCE on every provider, a redirect allowlist, and secure cookies.
- `account.accountLinking.enabled = false` is REQUIRED. No unsafe cross-provider linking by matching email; a second provider for the same human yields a separate isolated account.
- Pin `better-auth` (1.7.5); the atomic-provisioning mechanism depends on `createOAuthUser` behavior — re-verify on upgrade.

## Atomic provisioning (D-011)
- On first sign-in, provision the personal org/tenant in the SAME transaction as user+account creation. If Better Auth's adapter cannot participate in that single transaction, STOP and report — never split into a non-atomic after-hook that can orphan a user.

## Roles & admin bootstrap (rule 7)
- Platform role `{user, admin}` is server-side enforced and distinct from org `MembershipRole`.
- Grant `admin` ONLY when the VERIFIED provider email is in `BOOTSTRAP_ADMIN_EMAILS`; record it in `AuditEvent`.
- Admin-only surfaces are gated by the SERVER. Client-side hiding is never a security control.

## PAT UI & browser-secret hygiene (rules 2, 5)
- The raw PAT (`sclp_pat_<id>_<secret>`) is shown ONCE at mint; never re-fetchable. Do not cache/log/persist it (no localStorage of the secret, no analytics capture). Afterwards only public id/metadata is shown.
- Revocation takes effect immediately and the UI reflects it.
- Never render the internal Sculpin URL, upstream credential, or internal agent ids. Client model choices show only public aliases.
- No secrets in client bundles; only intended `NEXT_PUBLIC_*` values reach the browser.

## Env & startup
- Validate required env at startup; fail closed with a clear message. `.env.example` has names/docs only, never secrets.

## Tests before done
- `apps/web` unit/component tests (vitest); typecheck via `node node_modules/typescript/bin/tsc -p apps/web/tsconfig.json --noEmit` and lint via `node node_modules/eslint/bin/eslint.js apps/web` on engine mismatch. No live Google/GitHub calls — use test doubles.
