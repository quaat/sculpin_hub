import { test as base, expect } from "@playwright/test";
import { SEEDED_CATALOGUE } from "./global-setup";

/**
 * UNAUTHENTICATED journey (no seam sign-in; a fresh anonymous context).
 *
 * `/admin` is server-gated (404 for a signed-out caller). `/account` and
 * `/account/tokens` server-side render a sign-in prompt (never protected data).
 * Public pages render. The browser HTML / client payloads must contain NO
 * upstream URL, upstream API key, PAT verifier secret, OAuth tokens, or internal
 * Sculpin agent identifiers.
 */

// A brand-new context is anonymous by default; no fixture (no session) needed.
const test = base;

// Secrets/identifiers that must NEVER reach any client-visible surface. These
// are supplied by the E2E environment; the assertions are skipped for any value
// the environment did not set.
function forbiddenStrings(): string[] {
  const candidates = [
    process.env.SCULPIN_UPSTREAM_URL,
    process.env.SCULPIN_UPSTREAM_API_KEY,
    process.env.SCULPIN_DISCOVERY_API_KEY,
    process.env.PAT_HASH_SECRET,
    process.env.BETTER_AUTH_SECRET,
    process.env.E2E_SESSION_SEED_KEY,
    SEEDED_CATALOGUE.upstreamAgentId,
  ];
  return candidates.filter((v): v is string => Boolean(v) && v!.length > 0);
}

test.describe("unauthenticated journey", () => {
  test("/admin is server-denied for a signed-out caller", async ({ page }) => {
    const response = await page.goto("/admin");
    expect(response?.status()).toBe(404);
  });

  test("/account renders a sign-in prompt, not protected data", async ({
    page,
  }) => {
    await page.goto("/account");
    await expect(
      page.getByRole("heading", { name: /Sign in to view your account/i }),
    ).toBeVisible();
    // No subscriptions table / entitlement data for an anonymous caller.
    await expect(page.locator("#entitlement-heading")).toHaveCount(0);
  });

  test("/account/tokens renders a sign-in prompt", async ({ page }) => {
    await page.goto("/account/tokens");
    await expect(
      page.getByRole("heading", { name: /Sign in to manage tokens/i }),
    ).toBeVisible();
  });

  test("public pages render", async ({ page }) => {
    await page.goto("/products");
    await expect(
      page.getByRole("heading", { name: /Explore Sculpin/i }),
    ).toBeVisible();
    await page.goto("/pricing");
    await expect(page.locator("#main")).toBeVisible();
  });

  test("no secrets or internal identifiers appear in client payloads", async ({
    page,
  }) => {
    const forbidden = forbiddenStrings();
    for (const path of ["/", "/products", "/pricing", "/account", "/dashboard"]) {
      await page.goto(path);
      const html = await page.content();
      for (const secret of forbidden) {
        expect(html, `${secret.slice(0, 6)}… must not appear on ${path}`).not.toContain(
          secret,
        );
      }
    }
  });
});
