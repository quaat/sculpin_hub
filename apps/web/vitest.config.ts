import { configDefaults, defineConfig } from "vitest/config";
export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    // The Playwright browser suite under `e2e/` is driven by Playwright (CI),
    // NOT Vitest. Exclude it so a normal `vitest`/`turbo test` run in the dev
    // sandbox never tries to execute browser specs (which need Postgres + a
    // running Next server + browsers that are unavailable here).
    exclude: [...configDefaults.exclude, "e2e/**"],
  },
});
