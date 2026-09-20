import { timingSafeEqual } from "node:crypto";
import type { BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint, APIError } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";

/**
 * TEST-ONLY authentication seam for the S15 browser/control-plane E2E suite.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SECURITY POSTURE — this module is the ONLY additional auth surface introduced
 * for testing and it is STRUCTURALLY ABSENT from production:
 *
 *  - It is imported ONLY by `buildE2EAuthOptions` in `auth.ts`, which is selected
 *    ONLY when `config.e2eTestAuth === true`. Production (`buildAuthOptions`)
 *    never references it, so the `/api/auth/e2e/sign-in` route does not exist in
 *    a production build.
 *  - `config.e2eTestAuth` can only be true when `E2E_TEST_AUTH === "1"` AND
 *    `NODE_ENV !== "production"`. Enabling the flag under production is a HARD
 *    startup failure (see `parseWebAuthConfig`), so a production deployment that
 *    accidentally carries the flag fails closed.
 *  - The handler DEFENSIVELY re-checks `process.env.E2E_TEST_AUTH === "1"` and a
 *    constant-time-compared server-only seed key before doing anything.
 *  - It NEVER creates users/accounts/organizations and NEVER provisions. It only
 *    MINTS a session for an ALREADY-SEEDED principal via the official
 *    `internalAdapter.createSession` + `setSessionCookie` primitives — the same
 *    path `getSession` validates — so it does not touch the atomic-provisioning
 *    hooks and does not alter `getSession`/`requireUser`/`requireAdmin`.
 *
 * The seed key is a SERVER-ONLY secret: it is compared here, never returned, and
 * never reaches the browser (the Playwright fixture sends it as the
 * `x-e2e-seed-key` header from a Node request context, not from page JS).
 * Nothing here is logged.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const E2E_SEAM_PLUGIN_ID = "e2e-session-seam";
export const E2E_SIGN_IN_PATH = "/e2e/sign-in";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parse the sign-in body without adding a schema dependency. Accepts EXACTLY one
 * of `{ userId }` (uuid) or `{ email }`. Returns `null` on any invalid shape so
 * the handler fails closed with an opaque error.
 */
function parseSignInBody(
  body: unknown,
): { userId: string } | { email: string } | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  const userId = record.userId;
  const email = record.email;
  if (typeof userId === "string" && uuidPattern.test(userId)) {
    return { userId };
  }
  if (typeof email === "string" && email.length > 3 && email.includes("@")) {
    return { email };
  }
  return null;
}

/**
 * Constant-time comparison that also treats a length mismatch as a failure.
 * `crypto.timingSafeEqual` throws on unequal-length buffers, so we branch on
 * length first (a length check is not itself secret-dependent).
 */
function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

/**
 * Build the TEST-ONLY session-seam plugin. Registers EXACTLY one endpoint,
 * `POST /e2e/sign-in` (final path `/api/auth/e2e/sign-in`). The factory has no
 * side effects on import beyond defining the plugin object.
 */
export function e2eSessionSeamPlugin({
  seedKey,
}: {
  seedKey: string;
}): BetterAuthPlugin {
  if (typeof seedKey !== "string" || seedKey.length < 32) {
    // Defense in depth: never construct a seam guarded by a weak/absent key.
    throw new Error("e2e_seam_requires_seed_key");
  }
  return {
    id: E2E_SEAM_PLUGIN_ID,
    endpoints: {
      e2eSignIn: createAuthEndpoint(
        E2E_SIGN_IN_PATH,
        {
          method: "POST",
        },
        async (ctx) => {
          // (1) Defensive runtime gate: even if this plugin were somehow wired,
          // refuse unless the flag is set. Return an opaque 404 — never a hint.
          if (process.env.E2E_TEST_AUTH !== "1") {
            throw new APIError("NOT_FOUND");
          }

          // (2) Constant-time seed-key check. Missing/short/wrong => opaque 404.
          const provided = ctx.getHeader("x-e2e-seed-key");
          if (
            typeof provided !== "string" ||
            !constantTimeEquals(provided, seedKey)
          ) {
            throw new APIError("NOT_FOUND");
          }

          // (3) Look up an EXISTING principal only. Never create/provision.
          const parsed = parseSignInBody(ctx.body);
          if (!parsed) {
            throw new APIError("NOT_FOUND");
          }
          const user =
            "userId" in parsed
              ? await ctx.context.internalAdapter.findUserById(parsed.userId)
              : (
                  await ctx.context.internalAdapter.findUserByEmail(
                    parsed.email,
                  )
                )?.user;
          if (!user) {
            throw new APIError("NOT_FOUND");
          }

          // (4) Mint the session and set the cookie via the OFFICIAL primitives
          // so `getSession` validates it exactly like a real sign-in.
          const session = await ctx.context.internalAdapter.createSession(
            user.id,
          );
          if (!session) {
            throw new APIError("NOT_FOUND");
          }
          await setSessionCookie(ctx, { session, user });

          // Return no secrets: no token, no seed key, no cookie value.
          return ctx.json({ ok: true });
        },
      ),
    },
  };
}
