import { describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "@sculpin/config";
import type { Database } from "@sculpin/db";
import { buildAuthOptions, withProvisioningTxCapture } from "./auth";

/**
 * Deterministic unit tests for the Better Auth options object. No DB, no
 * network: we assert provider registration, field mapping, session strategy,
 * trusted-origin pinning, and cookie-security attributes.
 */

const config: AuthConfig = {
  betterAuthSecret: "x".repeat(48),
  betterAuthUrl: "https://hub.example.com",
  googleClientId: "google-client-id",
  googleClientSecret: "google-client-secret",
  githubClientId: "github-client-id",
  githubClientSecret: "github-client-secret",
  bootstrapAdminEmails: ["admin@example.com"],
};

// Minimal Database double; buildAuthOptions only needs `.prisma` to hand to the
// adapter and never touches it in these assertions.
const database = { prisma: {}, pool: {} } as unknown as Database;

describe("buildAuthOptions", () => {
  it("registers Google and GitHub social providers with configured credentials", () => {
    const options = buildAuthOptions({ config, database });
    // Providers are configured as plain option objects (not lazy factories).
    const google = options.socialProviders?.google as
      | { clientId?: string }
      | undefined;
    const github = options.socialProviders?.github as
      | { clientId?: string }
      | undefined;
    expect(google?.clientId).toBe("google-client-id");
    expect(github?.clientId).toBe("github-client-id");
    // Account linking is disabled EXPLICITLY (Better Auth 1.7.5 defaults it ON),
    // so no implicit email-based cross-provider linking can occur.
    const account = options.account as
      | { accountLinking?: { enabled?: boolean } }
      | undefined;
    expect(account?.accountLinking?.enabled).toBe(false);
  });

  it("pins the secret and trusted origin to validated config only", () => {
    const options = buildAuthOptions({ config, database });
    expect(options.secret).toBe(config.betterAuthSecret);
    expect(options.baseURL).toBe("https://hub.example.com");
    expect(options.trustedOrigins).toEqual(["https://hub.example.com"]);
  });

  it("maps user and account models onto canonical tables without token columns", () => {
    const options = buildAuthOptions({ config, database });
    // modelName is the Prisma delegate (model) name, not the mapped table name;
    // Better Auth indexes the client via `prisma[modelName]`, so these must be
    // the camelCase model names (`user`, `externalIdentity`, `verification`),
    // NOT the plural `@@map` table names.
    expect(options.user?.modelName).toBe("user");
    expect(options.user?.fields).toMatchObject({
      email: "normalizedEmail",
      name: "displayName",
    });
    expect(options.account?.modelName).toBe("externalIdentity");
    expect(options.account?.fields).toMatchObject({
      providerId: "provider",
      accountId: "providerSubject",
    });
    // No verification/account token persistence knobs are enabled.
    expect(options.verification?.modelName).toBe("verification");
  });

  it("uses database sessions with no cookie cache", () => {
    const options = buildAuthOptions({ config, database });
    expect(options.session?.expiresIn).toBe(60 * 60 * 24 * 7);
    // Absence of cookieCache => every request re-checks the DB (revocation
    // and deactivation take effect immediately).
    expect(options.session).not.toHaveProperty("cookieCache");
  });

  it("emits HttpOnly, SameSite=Lax cookies (Secure in production only)", () => {
    const options = buildAuthOptions({ config, database });
    const attrs = options.advanced?.defaultCookieAttributes;
    expect(attrs?.httpOnly).toBe(true);
    expect(attrs?.sameSite).toBe("lax");
    expect(options.advanced?.cookiePrefix).toBe("sculpin-hub");
    // NODE_ENV is not "production" in the test runner => not forced Secure.
    expect(attrs?.secure).toBe(false);
    expect(options.advanced?.useSecureCookies).toBe(false);
  });

  it("never echoes the secret through the app name or origins", () => {
    const options = buildAuthOptions({ config, database });
    const serialized = JSON.stringify({
      appName: options.appName,
      baseURL: options.baseURL,
      trustedOrigins: options.trustedOrigins,
    });
    expect(serialized).not.toContain(config.betterAuthSecret);
  });
});

// Minimal fake interactive-transaction client for the atomic provisioning path.
function fakeProvisioningTx() {
  let queryCall = 0;
  const $queryRaw = vi.fn(() => {
    queryCall += 1;
    // 1st call: existing-org lookup (none) -> []; 2nd: org INSERT RETURNING id.
    return Promise.resolve(
      queryCall === 1
        ? []
        : [{ id: "22222222-2222-4222-8222-222222222222" }],
    );
  });
  const $executeRaw = vi.fn(() => Promise.resolve(1));
  return { $queryRaw, $executeRaw };
}

describe("withProvisioningTxCapture", () => {
  it("runs the interactive transaction callback with the tx client", async () => {
    const tx = { marker: "tx" };
    const prisma = {
      $transaction: vi.fn((fn: (t: unknown) => unknown) => fn(tx)),
      other: "kept",
    };
    const proxied = withProvisioningTxCapture(prisma as unknown as object) as {
      $transaction: (fn: (t: unknown) => unknown) => unknown;
      other: string;
    };
    const seen = await proxied.$transaction((t) => Promise.resolve(t));
    expect(seen).toBe(tx);
    // Non-transaction members pass through untouched.
    expect(proxied.other).toBe("kept");
  });

  it("delegates the array (batch) transaction form untouched", async () => {
    const inner = vi.fn((arg: unknown) => Promise.resolve(arg));
    const prisma = { $transaction: inner };
    const proxied = withProvisioningTxCapture(prisma as unknown as object) as {
      $transaction: (arg: unknown) => unknown;
    };
    const batch = [Promise.resolve(1)];
    await proxied.$transaction(batch);
    expect(inner).toHaveBeenCalledWith(batch, undefined);
  });
});

describe("atomic provisioning hook (account.create.before)", () => {
  const userId = "11111111-1111-4111-8111-111111111111";

  it("fails closed when no transaction is in scope", async () => {
    const options = buildAuthOptions({ config, database });
    const before = options.databaseHooks?.account?.create?.before;
    expect(before).toBeTypeOf("function");
    await expect(
      (before as (a: unknown) => Promise<unknown>)({ userId }),
    ).rejects.toThrow(/provisioning_transaction_unavailable/);
  });

  it("provisions the personal tenant inside the sign-up transaction", async () => {
    const options = buildAuthOptions({ config, database });
    const before = options.databaseHooks?.account?.create?.before as (
      a: unknown,
    ) => Promise<unknown>;
    const tx = fakeProvisioningTx();
    const prisma = {
      $transaction: (fn: (t: unknown) => unknown) => fn(tx),
    };
    const proxied = withProvisioningTxCapture(prisma as unknown as object) as {
      $transaction: (fn: (t: unknown) => unknown) => unknown;
    };

    const account = { userId, providerId: "google", accountId: "sub-1" };
    const result = await proxied.$transaction(() => before(account));

    // Hook returns the account with the identity fields preserved so the
    // adapter proceeds to insert it...
    const data = (result as { data: Record<string, unknown> }).data;
    expect(data.userId).toBe(userId);
    expect(data.providerId).toBe("google");
    expect(data.accountId).toBe("sub-1");
    // ...but every OAuth token/credential field is stripped to `undefined`
    // (ADR 006) so transformInput skips it and no token value is ever written.
    expect(data.accessToken).toBeUndefined();
    expect(data.refreshToken).toBeUndefined();
    expect(data.idToken).toBeUndefined();
    expect(data.accessTokenExpiresAt).toBeUndefined();
    expect(data.refreshTokenExpiresAt).toBeUndefined();
    expect(data.scope).toBeUndefined();
    expect(data.password).toBeUndefined();
    // Provider email is absent in this path (no profile captured); the verified
    // flag defaults to false (H-1 durable row backs the admin decision).
    expect(data.providerEmail).toBeUndefined();
    expect(data.emailVerified).toBe(false);
    // org INSERT + membership + audit + outbox + trial subscription all ran
    // against the tx client.
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(4);
  });

  it("rejects an account create without a user id", async () => {
    const options = buildAuthOptions({ config, database });
    const before = options.databaseHooks?.account?.create?.before as (
      a: unknown,
    ) => Promise<unknown>;
    const prisma = { $transaction: (fn: (t: unknown) => unknown) => fn({}) };
    const proxied = withProvisioningTxCapture(prisma as unknown as object) as {
      $transaction: (fn: (t: unknown) => unknown) => unknown;
    };
    await expect(
      proxied.$transaction(() => before({ providerId: "google" })),
    ).rejects.toThrow(/provisioning_missing_user_id/);
  });

  it("elevates an allowlisted, verified email to admin inside the transaction", async () => {
    const options = buildAuthOptions({ config, database });
    const userBefore = options.databaseHooks?.user?.create?.before as (
      u: unknown,
    ) => Promise<unknown>;
    const accountBefore = options.databaseHooks?.account?.create?.before as (
      a: unknown,
    ) => Promise<unknown>;
    const orgId = "22222222-2222-4222-8222-222222222222";
    // $queryRaw call order: (1) org lookup [], (2) org INSERT [{orgId}],
    // (3) UPDATE users RETURNING [{userId}], (4) SELECT org [{orgId}].
    let q = 0;
    const responses = [[], [{ id: orgId }], [{ id: userId }], [{ id: orgId }]];
    const tx = {
      $queryRaw: vi.fn(() => Promise.resolve(responses[q++] ?? [])),
      $executeRaw: vi.fn(() => Promise.resolve(1)),
    };
    const prisma = { $transaction: (fn: (t: unknown) => unknown) => fn(tx) };
    const proxied = withProvisioningTxCapture(prisma as unknown as object) as {
      $transaction: (fn: (t: unknown) => unknown) => unknown;
    };

    await proxied.$transaction(async () => {
      await userBefore({ email: "admin@example.com", emailVerified: true });
      await accountBefore({ userId, providerId: "google", accountId: "s" });
    });

    // Provisioning (2 queries) + admin bootstrap (UPDATE + org SELECT = 2).
    expect(tx.$queryRaw).toHaveBeenCalledTimes(4);
    // Provisioning writes 4 rows (membership/audit/outbox/trial) + admin
    // bootstrap audit = 5.
    expect(tx.$executeRaw).toHaveBeenCalledTimes(5);
  });

  it("does not elevate an unverified allowlisted email", async () => {
    const options = buildAuthOptions({ config, database });
    const userBefore = options.databaseHooks?.user?.create?.before as (
      u: unknown,
    ) => Promise<unknown>;
    const accountBefore = options.databaseHooks?.account?.create?.before as (
      a: unknown,
    ) => Promise<unknown>;
    const tx = fakeProvisioningTx();
    const prisma = { $transaction: (fn: (t: unknown) => unknown) => fn(tx) };
    const proxied = withProvisioningTxCapture(prisma as unknown as object) as {
      $transaction: (fn: (t: unknown) => unknown) => unknown;
    };

    await proxied.$transaction(async () => {
      await userBefore({ email: "admin@example.com", emailVerified: false });
      await accountBefore({ userId, providerId: "google", accountId: "s" });
    });

    // Only provisioning ran; no admin-bootstrap UPDATE/SELECT/audit.
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(4);
  });
});
