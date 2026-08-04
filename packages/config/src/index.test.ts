import { describe, expect, it } from "vitest";
import {
  parseProxyConfig,
  parseWebConfig,
  parseWorkerConfig,
} from "./index.js";
const valid = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://user:canary-secret@localhost:5432/test",
};
describe("runtime configuration", () => {
  it("parses separate valid application configuration", () => {
    expect(parseWebConfig(valid).environment).toBe("test");
    expect(
      parseProxyConfig({ ...valid, PROXY_PORT: "3101" }).bodyLimitBytes,
    ).toBe(1048576);
    expect(parseWorkerConfig(valid).shutdownTimeoutMs).toBe(10000);
  });
  it("reports missing fields without values", () => {
    expect(() => parseWebConfig({ DATABASE_URL: "" })).toThrow("DATABASE_URL");
  });
  it("rejects invalid ports and URLs", () => {
    expect(() => parseProxyConfig({ ...valid, PROXY_PORT: "70000" })).toThrow(
      "PROXY_PORT",
    );
    expect(() =>
      parseWebConfig({
        ...valid,
        DATABASE_URL: "https://canary-secret.example",
      }),
    ).toThrow("DATABASE_URL");
  });
  it("does not echo secret values in errors", () => {
    expect(() =>
      parseWebConfig({ DATABASE_URL: "canary-secret" }),
    ).toThrowError(expect.not.stringContaining("canary-secret"));
  });
  it("requires deliberate production binding", () => {
    expect(() =>
      parseProxyConfig({ ...valid, NODE_ENV: "production", PROXY_HOST: "" }),
    ).toThrow("PROXY_HOST");
  });
  it("rejects local development database credentials in production", () => {
    expect(() =>
      parseWebConfig({
        NODE_ENV: "production",
        DATABASE_URL:
          "postgresql://sculpin:local-development-only@localhost:5432/sculpin_hub",
      }),
    ).toThrow("DATABASE_URL production safety");
  });
});
