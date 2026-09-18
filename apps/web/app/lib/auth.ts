import { AsyncLocalStorage } from "node:async_hooks";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { parseWebAuthConfig, type AuthConfig } from "@sculpin/config";
import { getDatabase, type Database } from "@sculpin/db";
import {
  personalOrganizationSlug,
  provisionPersonalTenant,
  type ProvisioningTx,
} from "./provisioning";
import { reconcileAdminBootstrap } from "./admin-bootstrap";

/**
 * M2 identity slice — Better Auth control-plane configuration.
 *
 * Security posture (see docs/adr/004 and CLAUDE.md):
 * - Database (server-side) session strategy — the cookie carries only the
 *   opaque `session.token`; revocation deletes/expires the row.
 * - Google (OIDC) + GitHub (OAuth2). Better Auth's OAuth2 core applies
 *   Authorization-Code + PKCE (S256) + state on EVERY social provider by
 *   default, and OIDC nonce for Google. This neutralizes the provider
 *   confusion class in GHSA-x445-f3h2-j279.
 * - `trustedOrigins` is pinned to BETTER_AUTH_URL only; no client/env-selected
 *   redirect targets.
 * - Secure, HttpOnly, SameSite=Lax, host-scoped cookies in production.
 * - Account linking OFF by default (no `accountLinking` block => no auto-link
 *   by email). Enforces CLAUDE.md rule 7.
 * - The Better Auth secret is centralized from validated config and never
 *   logged or hardcoded.
 *
 * ── Atomic sign-up provisioning (D-011) ───────────────────────────────────
 * Better Auth's OAuth new-user path (`createOAuthUser`) creates the `user` and
 * `account` rows inside ONE interactive Prisma transaction. We piggy-back on
 * that transaction to insert the personal org + owner membership + audit +
 * outbox so a new user is never left without a tenant context (no orphan
 * window), WITHOUT reimplementing the adapter's where/join/sort translation:
 *   1. The Prisma client handed to the adapter is proxied so every interactive
 *      `$transaction(fn)` runs `fn` inside an AsyncLocalStorage that carries the
 *      transaction client + per-sign-up context (`provisioningTxStorage`).
 *   2. `databaseHooks.user.create.before` runs INSIDE that transaction and is the
 *      only seam that carries the provider's `emailVerified`; it stashes the
 *      verified profile in the ALS context (no id yet).
 *   3. `databaseHooks.account.create.before` runs INSIDE the same transaction,
 *      AFTER the user row exists (account create is step 2 of `createOAuthUser`)
 *      and BEFORE the account row is written. It reads the tx from the ALS, runs
 *      `provisionPersonalTenant`, then `reconcileAdminBootstrap` (D-010 item 3)
 *      using the captured verified profile — so provisioning AND any role
 *      elevation commit or roll back atomically with the sign-up.
 * Fail-closed: if no transaction client is in scope we throw rather than create
 * an account (and therefore a user) without a personal org. This couples us to
 * Better Auth's transactional `createOAuthUser` shape and to `emailVerified`
 * being present in `user.create.before` — pin `better-auth` and re-verify on
 * upgrade (D-011).
 * ──────────────────────────────────────────────────────────────────────────
 */

/**
 * Per-sign-up context carried from the adapter's `$transaction` down to the
 * user/account create hooks that run inside it. `tx` is the interactive
 * transaction client; `profile` is the verified provider identity captured in
 * `user.create.before` (the only in-transaction seam that sees `emailVerified`)
 * and consumed by the admin-bootstrap step in `account.create.before`.
 */
interface ProvisioningContext {
  readonly tx: ProvisioningTx;
  profile?: { email: string | null; emailVerified: boolean };
}

const provisioningTxStorage = new AsyncLocalStorage<ProvisioningContext>();

/**
 * Wrap a Prisma client so interactive `$transaction(fn)` calls execute `fn`
 * within `provisioningTxStorage`, exposing the transaction client to the
 * account-create hook. Non-callback (`array`) transactions and all other
 * members are delegated untouched, so the stock adapter behaviour is preserved.
 */
export function withProvisioningTxCapture<T extends object>(prisma: T): T {
  return new Proxy(prisma, {
    get(target, prop, receiver) {
      if (prop === "$transaction") {
        const original = Reflect.get(target, prop, receiver) as unknown;
        if (typeof original !== "function") return original;
        return (arg: unknown, options?: unknown) => {
          if (typeof arg === "function") {
            const run = arg as (tx: ProvisioningTx) => unknown;
            return (original as (...a: unknown[]) => unknown).call(
              target,
              (tx: ProvisioningTx) =>
                provisioningTxStorage.run({ tx }, () => run(tx)),
              options,
            );
          }
          return (original as (...a: unknown[]) => unknown).call(
            target,
            arg,
            options,
          );
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

export interface AuthDependencies {
  readonly config: AuthConfig;
  readonly database: Database;
}

export function resolveAuthDependencies(
  env: NodeJS.ProcessEnv = process.env,
): AuthDependencies {
  const config = parseWebAuthConfig(env);
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "Invalid runtime configuration. Check: DATABASE_URL for the auth control plane.",
    );
  }
  return { config, database: getDatabase(databaseUrl) };
}

/**
 * Build the Better Auth options object. Exported for deterministic unit tests
 * (provider registration + cookie/security attributes) without booting the DB.
 */
export function buildAuthOptions({
  config,
  database,
}: AuthDependencies): BetterAuthOptions {
  const isProduction = process.env.NODE_ENV === "production";
  return {
    appName: "Sculpin Knowledge Hub",
    // The strong server-side secret. Sourced from validated config; never
    // hardcoded or logged.
    secret: config.betterAuthSecret,
    baseURL: config.betterAuthUrl,
    // Redirect allowlist: the canonical Hub origin is the only trusted origin.
    trustedOrigins: [config.betterAuthUrl],
    database: prismaAdapter(withProvisioningTxCapture(database.prisma), {
      provider: "postgresql",
      // Enable real interactive transactions so user + account creation and the
      // personal-tenant provisioning (below) commit atomically.
      transaction: true,
    }),
    // Database (server-side) session strategy is Better Auth's default; make
    // the security-relevant knobs explicit.
    session: {
      // Fresh server-side session per sign-in (session-fixation avoidance).
      expiresIn: 60 * 60 * 24 * 7, // 7 days
      updateAge: 60 * 60 * 24, // refresh expiry at most daily
      // No cookie cache: every request re-checks the DB so deactivation /
      // ADMIN changes / "sign out everywhere" take effect immediately.
    },
    socialProviders: {
      google: {
        clientId: config.googleClientId,
        clientSecret: config.googleClientSecret,
        // Do not silently create-then-link across providers by email.
        disableImplicitSignUp: false,
      },
      github: {
        clientId: config.githubClientId,
        clientSecret: config.githubClientSecret,
        disableImplicitSignUp: false,
      },
    },
    // Map Better Auth's `user` onto the canonical `users` table. `email` and
    // `name` map to existing columns; we deliberately do NOT add
    // email/emailVerified/image columns (ADR-004 / D-010).
    user: {
      modelName: "users",
      fields: {
        email: "normalizedEmail",
        name: "displayName",
      },
    },
    // Map Better Auth's `account` onto `external_identities`:
    // providerId -> provider, accountId -> providerSubject. Provider access/
    // refresh/id tokens are NOT persisted (minimal token retention).
    account: {
      modelName: "externalIdentities",
      fields: {
        providerId: "provider",
        accountId: "providerSubject",
      },
      // CLAUDE.md rule 7 / GHSA-x445-f3h2-j279: NO automatic cross-provider
      // account linking. Better Auth 1.7.5 defaults `accountLinking.enabled` to
      // TRUE with implicit on-sign-in linking, so we must disable it EXPLICITLY
      // rather than by omission. Consequence (accepted for v1): the same human
      // signing in with a second provider gets a separate, isolated account
      // (normalized_email is non-unique) — never a silent link/takeover. A
      // deliberate, session-authenticated linking flow can be added later.
      accountLinking: { enabled: false },
    },
    verification: { modelName: "verifications" },
    // Atomic personal-tenant provisioning (D-011) + admin bootstrap (D-010 item
    // 3). Both run inside the same interactive transaction that
    // `createOAuthUser` opened for the user + account inserts, so the personal
    // org/membership/audit/outbox and any role elevation either all commit with
    // the sign-up or all roll back. `user.create.before` is the only
    // in-transaction seam that carries the provider's `emailVerified`, so we
    // capture the verified profile there and consume it in
    // `account.create.before` (which runs after the user row exists).
    databaseHooks: {
      user: {
        create: {
          before: (user) => {
            const ctx = provisioningTxStorage.getStore();
            if (ctx) {
              const email = (user as { email?: unknown }).email;
              const emailVerified = (user as { emailVerified?: unknown })
                .emailVerified;
              ctx.profile = {
                email: typeof email === "string" ? email : null,
                emailVerified: emailVerified === true,
              };
            }
            return Promise.resolve({ data: user });
          },
        },
      },
      account: {
        create: {
          before: async (account) => {
            const ctx = provisioningTxStorage.getStore();
            if (!ctx) {
              // No transaction in scope: refuse to create the account (and thus
              // leave a user without a personal org). Fail closed.
              throw new Error("provisioning_transaction_unavailable");
            }
            const userId = (account as { userId?: unknown }).userId;
            if (typeof userId !== "string" || userId.length === 0) {
              throw new Error("provisioning_missing_user_id");
            }
            const requestId = `signup-${globalThis.crypto.randomUUID()}`;
            await provisionPersonalTenant(ctx.tx, {
              userId,
              organizationSlug: personalOrganizationSlug(),
              requestId,
            });
            // Idempotent role elevation for allowlisted, VERIFIED emails only.
            // Runs after provisioning so the personal org exists for the
            // org-scoped audit row; in-transaction so it is atomic with sign-up.
            await reconcileAdminBootstrap(ctx.tx, {
              userId,
              providerEmail: ctx.profile?.email,
              emailVerified: ctx.profile?.emailVerified ?? false,
              allowlist: config.bootstrapAdminEmails,
              requestId,
            });
            // Return the account unchanged; the adapter proceeds to insert it.
            return { data: account };
          },
        },
      },
    },
    advanced: {
      // Force Secure cookies in production; host-scoped via cookiePrefix so the
      // library emits `__Secure-`/`__Host-`-style names behind the HTTPS edge.
      useSecureCookies: isProduction,
      cookiePrefix: "sculpin-hub",
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: "lax",
        secure: isProduction,
      },
    },
    plugins: [
      // Must be last: bridges Better Auth's Set-Cookie into Next.js responses.
      nextCookies(),
    ],
  } satisfies BetterAuthOptions;
}

let cached: ReturnType<typeof betterAuth> | undefined;

/**
 * Lazily construct the Better Auth server instance. Kept lazy so importing this
 * module (e.g. in the route handler) does not eagerly validate auth env at
 * build time; env is validated on first request, failing closed.
 */
export function getAuth(): ReturnType<typeof betterAuth> {
  cached ??= betterAuth(buildAuthOptions(resolveAuthDependencies()));
  return cached;
}
