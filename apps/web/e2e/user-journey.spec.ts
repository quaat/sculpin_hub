import { test, expect } from "./fixtures";
import { SEEDED_CATALOGUE, SEEDED_PLAN } from "./global-setup";

/**
 * USER journey (real UI + real authz below the auth seam).
 *
 * Claim an eligible self-service plan, see the active entitlement, mint a PAT,
 * see the COMPLETE token exactly once, prove it cannot be re-fetched, verify the
 * Connect page shows only the public alias (no internal ids/URL/secret), then
 * revoke the token and see it reflected immediately.
 */

test.describe("user journey", () => {
  test("claim plan, mint + one-time PAT reveal, connect, revoke", async ({
    userContext,
  }) => {
    const page = await userContext.newPage();

    // 1) Catalogue is persisted and shows the published alias.
    await page.goto("/products");
    await expect(page.getByRole("heading", { name: /Explore Sculpin/i })).toBeVisible();
    await expect(
      page.locator("code", { hasText: SEEDED_CATALOGUE.publicAlias }),
    ).toBeVisible();

    // 2) Claim the eligible self-service plan from the account page.
    await page.goto("/account");
    await page
      .getByRole("button", { name: new RegExp(`Claim ${SEEDED_PLAN.name}`, "i") })
      .click();
    await expect(page.getByText(/Claimed\. Your entitlement is updated\./i)).toBeVisible();

    // 3) Active entitlement is shown.
    await page.reload();
    await expect(
      page.locator("#entitlement-heading").locator("xpath=following::p[1]"),
    ).toContainText(/Active/i);

    // 4) Mint a PAT and capture the COMPLETE one-time secret.
    await page.goto("/account/tokens");
    await page.getByLabel(/Token name/i).fill("e2e-cli");
    await page.getByRole("button", { name: /Mint token/i }).click();

    const reveal = page.getByRole("alert");
    await expect(reveal).toBeVisible();
    const rawToken = (await reveal.locator("code").first().innerText()).trim();
    expect(rawToken).toMatch(/^sclp_pat_/);

    // 5) Dismiss and prove the raw token is no longer retrievable.
    await page.getByRole("button", { name: /I have saved it/i }).click();
    await page.reload();
    await expect(page.getByText(rawToken)).toHaveCount(0);
    // Only the public id / metadata remains.
    const publicId = rawToken.split("_").slice(0, 3).join("_"); // sclp_pat_<id>
    await expect(page.locator("code", { hasText: publicId.split("_")[2] }).first()).toBeVisible();

    // 6) Connect page shows the PUBLIC alias and NO internal ids/URL/secrets.
    await page.goto(`/connect/${encodeURIComponent(SEEDED_CATALOGUE.publicAlias)}`);
    await expect(page.locator("code", { hasText: SEEDED_CATALOGUE.publicAlias })).toBeVisible();
    const connectHtml = await page.content();
    expect(connectHtml).not.toContain(SEEDED_CATALOGUE.upstreamAgentId);
    expect(connectHtml).not.toContain(rawToken);

    // 7) Revoke the token; the status flips immediately.
    await page.goto("/account/tokens");
    await page.getByRole("button", { name: /Revoke/i }).first().click();
    await expect(page.getByText(/revoked/i).first()).toBeVisible();

    await page.close();
  });
});
