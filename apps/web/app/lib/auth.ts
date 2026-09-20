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
import { e2eSessionSeamPlugin } from "./e2e-auth-seam";

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
      modelName: "user",
      fields: {
        email: "normalizedEmail",
        name: "displayName",
      },
    },
    // Map Better Auth's `account` onto `external_identities`:
    // providerId -> provider, accountId -> providerSubject.
    //
    // OAuth token retention (ADR 006): the Hub authenticates with Google/GitHub
    // but never calls a provider API for the user, so it does NOT persist
    // provider access/refresh/id tokens. Better Auth would otherwise write them
    // to the account row, so we prune on two axes: `updateAccountOnSignIn:false`
    // stops the returning-sign-in token refresh, and `account.create.before`
    // (below) strips the token/credential fields before the insert. The columns
    // themselves are dropped (migration 20260919140000); see `validateSchema`.
    //
    // H-1: `providerEmail` / `emailVerified` are declared as additional account
    // fields and populated from the verified provider profile in
    // `account.create.before`, so the admin-bootstrap allowlist decision is
    // backed by the persisted row (auditability + defense-in-depth), not only
    // the in-memory ALS profile.
    account: {
      modelName: "externalIdentity",
      fields: {
        providerId: "provider",
        accountId: "providerSubject",
      },
      // INVARIANT (do not break): these persisted columns are AUDIT-ONLY. On the
      // OAuth sign-up path they are always overwritten in `account.create.before`
      // from the in-transaction VERIFIED provider profile, and the admin-bootstrap
      // decision reads that transient verified profile (`ctx.profile`), NEVER the
      // stored column. `input:true` is therefore acceptable today (a client cannot
      // reach an authz decision through them). If a future change ever keys an
      // authz decision off the stored `provider_email`/`email_verified` column,
      // flip these to `input:false` first — otherwise the value becomes
      // client-influenceable. (Security review 2026-09-19, LOW-1.)
      additionalFields: {
        providerEmail: { type: "string", required: false, input: true },
        emailVerified: {
          type: "boolean",
          required: false,
          input: true,
          defaultValue: false,
        },
      },
      // Do not refresh/store provider tokens on returning sign-in (see above).
      updateAccountOnSignIn: false,
      // CLAUDE.md rule 7 / GHSA-x445-f3h2-j279: NO automatic cross-provider
      // account linking. Better Auth 1.7.5 defaults `accountLinking.enabled` to
      // TRUE with implicit on-sign-in linking, so we must disable it EXPLICITLY
      // rather than by omission. Consequence (accepted for v1): the same human
      // signing in with a second provider gets a separate, isolated account
      // (normalized_email is non-unique) — never a silent link/takeover. A
      // deliberate, session-authenticated linking flow can be added later.
      accountLinking: { enabled: false },
    },
    verification: { modelName: "verification" },
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
            // Strip provider tokens before the insert (ADR 006): setting them to
            // `undefined` makes the adapter's transformInput skip the fields, so
            // no token value is ever written (the columns are dropped anyway).
            // Persist the verified provider email + flag (H-1) so the admin
            // decision above is backed by the durable row.
            return {
              data: {
                ...(account as Record<string, unknown>),
                accessToken: undefined,
                refreshToken: undefined,
                idToken: undefined,
                accessTokenExpiresAt: undefined,
                refreshTokenExpiresAt: undefined,
                scope: undefined,
                password: undefined,
                providerEmail: ctx.profile?.email ?? undefined,
                emailVerified: ctx.profile?.emailVerified ?? false,
              },
            };
          },
        },
      },
    },
    advanced: {
      // Our id columns are `@db.Uuid`; Better Auth's default id generator emits
      // non-UUID base64-ish strings (e.g. starting with `T`), which Postgres
      // rejects (P2023). Emit real UUIDs so inserts into every Better Auth table
      // (user/account/session/verification) match the column type.
      //
      // validateSchema:false — Better Auth's adapter schema check (v1.7.5)
      // requires a column for EVERY field it *could* write, including the OAuth
      // token columns we deliberately dropped (ADR 006). Since we strip those
      // fields before write, keeping the check on would fail closed on our own
      // pruning. Our Prisma migrations are the single schema authority and the
      // identity integration tests exercise real sign-in against a real DB, so
      // schema drift is caught there rather than by this check.
      database: {
        generateId: () => globalThis.crypto.randomUUID(),
        validateSchema: false,
      },
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

/**
 * TEST-ONLY variant of {@link buildAuthOptions} that appends the E2E
 * session-seam plugin (S15 browser E2E). The PRODUCTION options are left
 * byte-for-byte identical: this reuses `buildAuthOptions` unchanged and only
 * REPLACES the plugins array, inserting the seam BEFORE `nextCookies()` so
 * `nextCookies()` stays LAST (it must be last to bridge Set-Cookie into Next).
 *
 * Fails closed: requires `config.e2eTestAuth === true` and a seed key, and
 * refuses under `NODE_ENV=production` (defense in depth on top of the config
 * guard). Selected ONLY from `getAuth` when `config.e2eTestAuth` is true, so the
 * seam is structurally unreachable in production.
 */
export function buildE2EAuthOptions(deps: AuthDependencies): BetterAuthOptions {
  if (process.env.NODE_ENV === "production") {
    throw new Error("e2e_auth_options_forbidden_in_production");
  }
  const { config } = deps;
  if (config.e2eTestAuth !== true || !config.e2eSessionSeedKey) {
    throw new Error("e2e_auth_options_require_enabled_seam");
  }
  const base = buildAuthOptions(deps);
  return {
    ...base,
    // Rebuild the plugins array so `nextCookies()` remains LAST after the seam.
    plugins: [
      e2eSessionSeamPlugin({ seedKey: config.e2eSessionSeedKey }),
      nextCookies(),
    ],
  } satisfies BetterAuthOptions;
}

let cached: Promise<ReturnType<typeof betterAuth>> | undefined;

/**
 * Lazily construct the Better Auth server instance. Kept lazy so importing this
 * module (e.g. in the route handler) does not eagerly validate auth env at
 * build time; env is validated on first request, failing closed. The database's
 * Prisma client is initialized (`ready()`) before the adapter reads it, because
 * the `.prisma` getter throws until then and the auth path is the first thing to
 * touch the DB. A rejected initialization is not cached, so the next request
 * retries.
 */
export function getAuth(): Promise<ReturnType<typeof betterAuth>> {
  cached ??= (async () => {
    const deps = resolveAuthDependencies();
    await deps.database.ready();
    // Production is UNCHANGED: only the E2E branch (gated by the fail-closed
    // config flag) wires the test-only session seam.
    const options = deps.config.e2eTestAuth
      ? buildE2EAuthOptions(deps)
      : buildAuthOptions(deps);
    return betterAuth(options);
  })().catch((error: unknown) => {
    cached = undefined;
    throw error;
  });
  return cached;
}
