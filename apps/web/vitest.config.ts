import { defineConfig } from "vitest/config";
export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    passWithNoTests: false,
    coverage: { reporter: ["text"] },
  },
});
