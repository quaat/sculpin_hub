import {
  test as base,
  expect,
  request as playwrightRequest,
} from "@playwright/test";
import type { Browser, BrowserContext } from "@playwright/test";
import { PERSONAS } from "./global-setup";

/**
 * Playwright fixtures that authenticate a persona by calling the TEST-ONLY seam
 * endpoint `POST /api/auth/e2e/sign-in`.
 *
 * SECURITY: the server-only seed key is read from `process.env` and sent as the
 * `x-e2e-seed-key` header from a NODE request context — it is NEVER injected
 * into page/browser scripts. The seam returns only `{ ok: true }`; the session
 * cookie arrives via Set-Cookie and is captured into a browser context, so the
 * browser only ever holds the opaque session cookie (as with a real sign-in).
 */

type Persona = keyof typeof PERSONAS;

function seedKey(): string {
  const key = process.env.E2E_SESSION_SEED_KEY;
  if (!key) throw new Error("E2E_SESSION_SEED_KEY is required for the fixture");
  return key;
}

/**
 * Mint a session for a persona and return a browser context already carrying the
 * session cookie. Uses a throwaway Node request context so the seed key never
 * touches the browser.
 */
async function contextForPersona(
  browser: Browser,
  baseURL: string,
  persona: Persona,
): Promise<BrowserContext> {
  const api = await playwrightRequest.newContext({ baseURL });
  const response = await api.post("/api/auth/e2e/sign-in", {
    headers: { "x-e2e-seed-key": seedKey() },
    data: { email: PERSONAS[persona].email },
  });
  expect(response.ok(), `seam sign-in for ${persona}`).toBeTruthy();

  // storageState carries the Set-Cookie the seam issued; hydrate a browser ctx.
  const state = await api.storageState();
  await api.dispose();
  return browser.newContext({ storageState: state });
}

export const test = base.extend<{
  userContext: BrowserContext;
  adminContext: BrowserContext;
  unentitledContext: BrowserContext;
}>({
  userContext: async ({ browser, baseURL }, use) => {
    const context = await contextForPersona(browser, baseURL!, "user");
    await use(context);
    await context.close();
  },
  adminContext: async ({ browser, baseURL }, use) => {
    const context = await contextForPersona(browser, baseURL!, "admin");
    await use(context);
    await context.close();
  },
  unentitledContext: async ({ browser, baseURL }, use) => {
    const context = await contextForPersona(browser, baseURL!, "unentitled");
    await use(context);
    await context.close();
  },
});

export { expect } from "@playwright/test";
