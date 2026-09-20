import { test, expect } from "./fixtures";

/**
 * ADMIN journey (real server-side authorization).
 *
 * An ORDINARY user is DENIED the admin area (server-gated 404, not client
 * hiding). The admin creates a plan, publishes it, and it becomes visible to a
 * USER in the public catalogue / self-service list. Discovery renders either the
 * deterministic mocked agents (when CI points SCULPIN_UPSTREAM_URL at the fake
 * upstream) or the safe secret-free "unavailable" notice — never the internal
 * URL or credential.
 */

test.describe("admin journey", () => {
  test("ordinary user is server-denied the admin area", async ({
    userContext,
  }) => {
    const page = await userContext.newPage();
    const response = await page.goto("/admin");
    // Server gate returns 404 (notFound) for a non-admin — never the console.
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: /Admin console/i })).toHaveCount(0);
    await page.close();
  });

  test("admin accesses console, creates + publishes a plan visible to users", async ({
    adminContext,
    userContext,
  }) => {
    const admin = await adminContext.newPage();
    await admin.goto("/admin");
    await expect(admin.getByRole("heading", { name: /Admin console/i })).toBeVisible();

    // Discovery: agents table OR the safe unavailable notice, no secret leak.
    await admin.goto("/admin/discovery");
    await expect(admin.getByRole("heading", { name: /^Discovery$/i })).toBeVisible();
    const discoveryHtml = await admin.content();
    expect(discoveryHtml).not.toMatch(/Bearer\s+/);

    // Create a new self-service plan via the REAL admin action.
    const planKey = `e2e-admin-${Date.now()}`;
    const planName = `E2E Admin Plan ${Date.now()}`;
    await admin.goto("/admin/plans");
    await admin.getByLabel("Key", { exact: true }).fill(planKey);
    await admin.getByLabel("Name", { exact: true }).fill(planName);
    await admin.getByLabel(/Kind/i).selectOption("free_trial");
    await admin.getByLabel(/Request quota/i).fill("50");
    await admin.getByLabel(/Self-service eligible/i).check();
    await admin.getByRole("button", { name: /Create plan/i }).click();

    // The new plan card appears; publish it.
    const card = admin.locator("article.card", { hasText: planName });
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: /^Publish$/i }).click();
    await expect(
      admin.locator("article.card", { hasText: planName }),
    ).toContainText(/Published: true/i);

    // A USER now sees the published self-service plan on the account page.
    const user = await userContext.newPage();
    await user.goto("/account");
    await expect(
      user.getByRole("button", { name: new RegExp(`Claim ${planName}`, "i") }),
    ).toBeVisible();

    await admin.close();
    await user.close();
  });
});
