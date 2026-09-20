import { test, expect } from "./fixtures";
import { FAKE_STABLE_AGENT_ID } from "./fake-sculpin";

/**
 * ADMIN journey (real server-side authorization + the REAL product flow).
 *
 * An ORDINARY user is DENIED the admin area (server-gated 404, not client
 * hiding). The admin then walks the entire offering lifecycle end-to-end through
 * the real admin UI and server actions — no shortcuts, no mocked repositories:
 *
 *   discover Sculpin agents → bind a public alias to a STABLE upstream agent id
 *   (create a catalogue entry) → publish the entry → create a self-service plan →
 *   attach the offering to the plan → publish the plan
 *
 * and finally confirms the result is visible/claimable to a USER: the published
 * alias appears in the public catalogue and the published self-service plan is
 * claimable on the account page.
 *
 * Discovery is NOT mocked — the app reaches the deterministic fake Sculpin
 * upstream over the real credential-injecting adapter. The alias binds to
 * `FAKE_STABLE_AGENT_ID` (a UUID-form agent the fake upstream actually serves and
 * that the global seed does NOT consume), so drift stays empty and the entry is
 * genuinely resolvable. Fresh alias/key per run keep the flow independent of the
 * seeded fixtures and re-runnable against the same migrated DB.
 *
 * Security assertions kept inline: the admin discovery surface never leaks the
 * upstream credential ("Bearer …"); the public/user surfaces never carry the
 * internal upstream agent id.
 */

test.describe("admin journey", () => {
  test("ordinary user is server-denied the admin area", async ({
    userContext,
  }) => {
    const page = await userContext.newPage();
    const response = await page.goto("/admin");
    // Server gate returns 404 (notFound) for a non-admin — never the console.
    expect(response?.status()).toBe(404);
    await expect(
      page.getByRole("heading", { name: /Admin console/i }),
    ).toHaveCount(0);
    await page.close();
  });

  test("admin discovers, publishes an offering, and it becomes claimable by a user", async ({
    adminContext,
    userContext,
  }) => {
    const stamp = Date.now();
    const alias = `e2e-live-${stamp}`;
    const displayName = `E2E Live Offering ${stamp}`;
    const planKey = `e2e-live-plan-${stamp}`;
    const planName = `E2E Live Plan ${stamp}`;

    const admin = await adminContext.newPage();

    // 0) Console is reachable by an admin (server-side gate passes).
    await admin.goto("/admin");
    await expect(
      admin.getByRole("heading", { name: /Admin console/i }),
    ).toBeVisible();

    // 1) Discovery renders the deterministic fake agents over the REAL adapter,
    //    and never leaks the upstream credential.
    await admin.goto("/admin/discovery");
    await expect(
      admin.getByRole("heading", { name: /^Discovery$/i }),
    ).toBeVisible();
    await expect(
      admin
        .locator('section[aria-labelledby="discovered-heading"]')
        .locator("code", { hasText: FAKE_STABLE_AGENT_ID }),
    ).toBeVisible();
    expect(await admin.content()).not.toMatch(/Bearer\s+\S/);

    // 2) Bind a fresh public alias to the STABLE upstream agent id via the real
    //    create-from-discovered action (with admin-authored access instructions).
    await admin
      .getByLabel("Public alias", { exact: true })
      .fill(alias);
    await admin
      .getByLabel("Display name", { exact: true })
      .fill(displayName);
    await admin
      .getByLabel("Description (optional)", { exact: true })
      .fill("Deterministic live-flow offering.");
    await admin
      .getByLabel("Access instructions (optional)", { exact: true })
      .fill("Send an OpenAI chat completion; ask for a haiku.");
    await admin
      .getByLabel("Upstream agent (UUID)", { exact: true })
      .selectOption(FAKE_STABLE_AGENT_ID);
    await admin.getByRole("button", { name: /Create entry/i }).click();

    // 3) The new entry exists as a DRAFT in the catalogue; publish it. Its
    //    access instructions are recorded ("set"), and the upstream agent id is
    //    only ever on this admin-only surface.
    await admin.goto("/admin/catalogue");
    const entryCard = admin.locator("article.card", { hasText: displayName });
    await expect(entryCard).toBeVisible();
    await expect(entryCard).toContainText(/draft/i);
    await expect(entryCard).toContainText(/Access instructions:\s*set/i);
    await entryCard.getByRole("button", { name: /^Publish$/i }).click();
    await expect(
      admin.locator("article.card", { hasText: displayName }),
    ).toContainText(/published/i);

    // 4) Create a self-service plan via the real create action. New plans start
    //    enabled + unpublished; we publish after attaching the offering.
    await admin.goto("/admin/plans");
    const createPlan = admin.getByRole("region", { name: /Create a plan/i });
    await createPlan.getByLabel("Key", { exact: true }).fill(planKey);
    await createPlan.getByLabel("Name", { exact: true }).fill(planName);
    await createPlan.getByLabel(/Kind/i).selectOption("free_trial");
    await createPlan.getByLabel(/Request quota/i).fill("50");
    await createPlan.getByLabel(/Self-service eligible/i).check();
    await createPlan.getByRole("button", { name: /Create plan/i }).click();

    // 5) Attach the published offering to the plan, then publish the plan.
    const planCard = admin.locator("article.card", { hasText: planName });
    await expect(planCard).toBeVisible();
    await planCard
      .getByLabel("Offering to attach", { exact: true })
      .selectOption({ label: `${displayName} (${alias})` });
    await planCard.getByRole("button", { name: /Attach offering/i }).click();

    const attachedCard = admin.locator("article.card", { hasText: planName });
    await expect(attachedCard).toContainText(alias);
    await attachedCard.getByRole("button", { name: /^Publish$/i }).click();
    await expect(
      admin.locator("article.card", { hasText: planName }),
    ).toContainText(/Published: true/i);

    // 6) A USER now sees the published alias in the public catalogue — and the
    //    internal upstream agent id never appears on that client surface.
    const user = await userContext.newPage();
    await user.goto("/products");
    await expect(
      user.locator("code", { hasText: alias }),
    ).toBeVisible();
    expect(await user.content()).not.toContain(FAKE_STABLE_AGENT_ID);

    // 7) …and the published self-service plan is claimable on the account page.
    await user.goto("/account");
    await expect(
      user.getByRole("button", { name: new RegExp(`Claim ${planName}`, "i") }),
    ).toBeVisible();

    await admin.close();
    await user.close();
  });
});
