import { defineConfig, devices } from "@playwright/test";

/**
 * S15 browser/control-plane E2E configuration.
 *
 * This suite is a CI responsibility: it needs a running Postgres, migrations
 * deployed, browsers installed, and the Next server booted in E2E mode. It is
 * SKIPPED entirely unless `E2E_TEST_AUTH=1` so a normal dev-sandbox run never
 * tries to launch it. The seam it drives is TEST-ONLY and structurally absent
 * from production (see `app/lib/e2e-auth-seam.ts`).
 *
 * Determinism: a single worker, no retries, and a fixed port. Only OAuth and
 * Sculpin discovery are mocked; catalogue authorization, subscription/claim,
 * entitlement resolution, PAT minting/one-time-display, and admin authorization
 * all run REAL app code below the auth boundary.
 */

const PORT = Number(process.env.E2E_WEB_PORT ?? "3210");
const BASE_URL = `http://127.0.0.1:${PORT}`;

// The fake Sculpin upstream (real HTTP server, not a mock) runs on its own port
// so the app's discovery adapter makes a genuine round-trip. The Next process is
// pointed at this origin via SCULPIN_UPSTREAM_URL below, and both processes share
// the same ephemeral discovery credential.
const FAKE_SCULPIN_PORT = Number(process.env.SCULPIN_FAKE_PORT ?? "3211");
const FAKE_SCULPIN_URL = `http://127.0.0.1:${FAKE_SCULPIN_PORT}`;
// Ephemeral, run-scoped discovery credential. Explicit CI override wins; the
// default keeps a local `E2E_TEST_AUTH=1` invocation self-contained. It is NEVER
// a real Sculpin key — the upstream on the other end is the fake server.
const FAKE_DISCOVERY_KEY =
  process.env.SCULPIN_DISCOVERY_API_KEY ?? "e2e-fake-discovery-key-not-a-secret";

// Guard: only run when explicitly enabled. When disabled we still export a valid
// config (testDir with zero matching runs) so `playwright test` is a no-op and a
// mis-fire never fails CI's non-E2E lanes.
const enabled = process.env.E2E_TEST_AUTH === "1";

// No fallback: the seed key must be supplied explicitly (matches the fixture,
// which throws when unset). Only required when the suite is actually enabled, so
// loading this config in a disabled lane stays a no-op.
function requireSeedKey(): string {
  const key = process.env.E2E_SESSION_SEED_KEY;
  if (typeof key !== "string" || key.length < 32) {
    throw new Error(
      "E2E_SESSION_SEED_KEY (>= 32 chars) is required when E2E_TEST_AUTH=1",
    );
  }
  return key;
}

export default defineConfig({
  testDir: "./e2e",
  // Only *.spec.ts under e2e/ are Playwright specs (Vitest excludes e2e/**).
  testMatch: /.*\.spec\.ts$/,
  // Nothing matches when disabled, so the suite is a no-op outside CI E2E.
  testIgnore: enabled ? undefined : /.*/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    // The seed key is passed to the request-context fixture via env, never into
    // page JS. Declared here only so fixtures can read it from `process.env`.
    extraHTTPHeaders: {},
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: enabled
    ? [
        {
          // The deterministic fake Sculpin upstream. Started BEFORE Next so the
          // discovery adapter's real HTTP call has something to reach. Readiness
          // is polled on the unauthenticated /health route.
          command:
            "node --experimental-strip-types ./e2e/fake-sculpin.ts",
          url: `${FAKE_SCULPIN_URL}/health`,
          reuseExistingServer: false,
          timeout: 30_000,
          env: {
            SCULPIN_FAKE_PORT: String(FAKE_SCULPIN_PORT),
            SCULPIN_DISCOVERY_API_KEY: FAKE_DISCOVERY_KEY,
          },
        },
        {
          // Boot Next in E2E mode. The env carries the test-only seam flag + seed
          // key, and points discovery at the fake upstream over the real adapter
          // (SCULPIN_UPSTREAM_URL + a matching SCULPIN_DISCOVERY_API_KEY). A test
          // DATABASE_URL, dummy OAuth ids (no live provider calls), and the admin
          // persona in BOOTSTRAP_ADMIN_EMAILS come from the CI job env.
          command: "node ./node_modules/next/dist/bin/next dev -p " + PORT,
          url: BASE_URL,
          reuseExistingServer: false,
          timeout: 120_000,
          env: {
            NODE_ENV: "test",
            E2E_TEST_AUTH: "1",
            E2E_SESSION_SEED_KEY: requireSeedKey(),
            BETTER_AUTH_URL: BASE_URL,
            // Real discovery adapter, fake upstream on the other end of the socket.
            SCULPIN_UPSTREAM_URL: FAKE_SCULPIN_URL,
            SCULPIN_DISCOVERY_API_KEY: FAKE_DISCOVERY_KEY,
            // The rest (DATABASE_URL, BETTER_AUTH_SECRET, GOOGLE_*/GITHUB_*,
            // BOOTSTRAP_ADMIN_EMAILS, PAT_HASH_SECRET, HUB_PUBLIC_URL) are
            // supplied by the CI job environment and inherited here.
          },
        },
      ]
    : undefined,
});
