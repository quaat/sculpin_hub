import { describe, expect, it } from "vitest";
import {
  parseDataPlaneConfig,
  parseDiscoveryConfig,
  parsePatConfig,
  parseProxyConfig,
  parseWebAuthConfig,
  parseWebConfig,
  parseWorkerConfig,
} from "./index.js";
const valid = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://user:canary-secret@localhost:5432/test",
};
const validAuth = {
  NODE_ENV: "test",
  BETTER_AUTH_SECRET: "unit-test-better-auth-secret-32chars!!",
  BETTER_AUTH_URL: "http://localhost:3000",
  GOOGLE_CLIENT_ID: "google-client-id",
  GOOGLE_CLIENT_SECRET: "google-client-secret",
  GITHUB_CLIENT_ID: "github-client-id",
  GITHUB_CLIENT_SECRET: "github-client-secret",
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
    let message = "";
    try {
      parseWebConfig({ DATABASE_URL: "canary-secret" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toBe("");
    expect(message).not.toContain("canary-secret");
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
describe("web auth configuration", () => {
  it("parses a complete auth environment", () => {
    const config = parseWebAuthConfig(validAuth);
    expect(config.betterAuthUrl).toBe("http://localhost:3000");
    expect(config.googleClientId).toBe("google-client-id");
    expect(config.bootstrapAdminEmails).toEqual([]);
  });
  it("normalizes and lowercases the admin allowlist", () => {
    const config = parseWebAuthConfig({
      ...validAuth,
      BOOTSTRAP_ADMIN_EMAILS: " Root@Example.com , second@example.io ",
    });
    expect(config.bootstrapAdminEmails).toEqual([
      "root@example.com",
      "second@example.io",
    ]);
  });
  it("fails closed when required auth env is missing", () => {
    expect(() => parseWebAuthConfig({ NODE_ENV: "test" })).toThrow(
      "BETTER_AUTH_SECRET",
    );
  });
  it("rejects a short auth secret", () => {
    expect(() =>
      parseWebAuthConfig({ ...validAuth, BETTER_AUTH_SECRET: "too-short" }),
    ).toThrow("BETTER_AUTH_SECRET");
  });
  it("rejects invalid admin emails", () => {
    expect(() =>
      parseWebAuthConfig({
        ...validAuth,
        BOOTSTRAP_ADMIN_EMAILS: "not-an-email",
      }),
    ).toThrow("BOOTSTRAP_ADMIN_EMAILS");
  });
  it("does not echo the auth secret in errors", () => {
    let message = "";
    try {
      parseWebAuthConfig({
        ...validAuth,
        BETTER_AUTH_URL: "not a url",
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("BETTER_AUTH_URL");
    expect(message).not.toContain(validAuth.BETTER_AUTH_SECRET);
  });
  it("requires a secure origin in production", () => {
    expect(() =>
      parseWebAuthConfig({
        ...validAuth,
        NODE_ENV: "production",
        BETTER_AUTH_URL: "http://hub.example.com",
      }),
    ).toThrow("BETTER_AUTH_URL production safety");
  });
});

describe("PAT-hash configuration (least privilege)", () => {
  const validPat = {
    PAT_HASH_SECRET: "unit-test-pat-hash-secret-32chars!!!",
  };
  it("parses the keyring from only the PAT secret", () => {
    const { patHashSecret, patHashKeyring } = parsePatConfig(validPat);
    expect(patHashSecret).toBe("unit-test-pat-hash-secret-32chars!!!");
    expect(patHashKeyring.currentVersion).toBe(1);
    expect(patHashKeyring.keys.get(1)).toBe(
      "unit-test-pat-hash-secret-32chars!!!",
    );
    expect(patHashKeyring.keys.size).toBe(1);
  });
  it("does NOT require the data-plane upstream URL or credential", () => {
    // The whole point of S7: minting/verifying PATs must not force the web
    // control plane to hold the upstream Sculpin key or URL.
    expect(() => parsePatConfig(validPat)).not.toThrow();
  });
  it("merges retired keys while keeping the current key", () => {
    const retired = "retired-pat-hash-secret-32chars-long!";
    const { patHashKeyring } = parsePatConfig({
      ...validPat,
      PAT_HASH_KEY_VERSION: "2",
      PAT_HASH_SECRET_RETIRED: JSON.stringify({ "1": retired }),
    });
    expect(patHashKeyring.currentVersion).toBe(2);
    expect(patHashKeyring.keys.get(2)).toBe(
      "unit-test-pat-hash-secret-32chars!!!",
    );
    expect(patHashKeyring.keys.get(1)).toBe(retired);
  });
  it("fails closed on a retired-version collision", () => {
    expect(() =>
      parsePatConfig({
        ...validPat,
        PAT_HASH_KEY_VERSION: "1",
        PAT_HASH_SECRET_RETIRED: JSON.stringify({
          "1": "another-pat-hash-secret-32chars-long!",
        }),
      }),
    ).toThrow("PAT_HASH_SECRET_RETIRED version collision");
  });
  it("rejects a short PAT hash secret", () => {
    expect(() => parsePatConfig({ PAT_HASH_SECRET: "too-short" })).toThrow(
      "PAT_HASH_SECRET",
    );
  });
  it("does not echo the secret in errors", () => {
    let message = "";
    try {
      parsePatConfig({ PAT_HASH_SECRET: "too-short-canary" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("PAT_HASH_SECRET");
    expect(message).not.toContain("too-short-canary");
  });
});

describe("data-plane configuration", () => {
  const validDataPlane = {
    NODE_ENV: "test",
    HUB_PUBLIC_URL: "http://localhost:3002",
    SCULPIN_UPSTREAM_URL: "http://sculpin.internal:8001",
    SCULPIN_UPSTREAM_API_KEY: "sk-upstream-canary-secret",
    PAT_HASH_SECRET: "unit-test-pat-hash-secret-32chars!!!",
  };
  it("parses a complete data-plane environment", () => {
    const config = parseDataPlaneConfig(validDataPlane);
    expect(config.hubPublicUrl).toBe("http://localhost:3002");
    expect(config.sculpinUpstreamUrl).toBe("http://sculpin.internal:8001");
    expect(config.sculpinUpstreamApiKey).toBe("sk-upstream-canary-secret");
    expect(config.patHashSecret).toBe("unit-test-pat-hash-secret-32chars!!!");
  });

  it("builds a default v1 keyring from PAT_HASH_SECRET", () => {
    const { patHashKeyring } = parseDataPlaneConfig(validDataPlane);
    expect(patHashKeyring.currentVersion).toBe(1);
    expect(patHashKeyring.keys.get(1)).toBe(
      "unit-test-pat-hash-secret-32chars!!!",
    );
    expect(patHashKeyring.keys.size).toBe(1);
  });

  it("merges retired keys into the keyring while keeping the current key", () => {
    const retired = "retired-pat-hash-secret-32chars-long!";
    const { patHashKeyring } = parseDataPlaneConfig({
      ...validDataPlane,
      PAT_HASH_KEY_VERSION: "2",
      PAT_HASH_SECRET_RETIRED: JSON.stringify({ "1": retired }),
    });
    expect(patHashKeyring.currentVersion).toBe(2);
    expect(patHashKeyring.keys.get(2)).toBe(
      "unit-test-pat-hash-secret-32chars!!!",
    );
    expect(patHashKeyring.keys.get(1)).toBe(retired);
  });

  it("fails closed on malformed retired-keys JSON", () => {
    expect(() =>
      parseDataPlaneConfig({
        ...validDataPlane,
        PAT_HASH_SECRET_RETIRED: "{not json",
      }),
    ).toThrow("PAT_HASH_SECRET_RETIRED");
  });

  it("fails closed on a short retired key", () => {
    expect(() =>
      parseDataPlaneConfig({
        ...validDataPlane,
        PAT_HASH_KEY_VERSION: "2",
        PAT_HASH_SECRET_RETIRED: JSON.stringify({ "1": "too-short" }),
      }),
    ).toThrow("PAT_HASH_SECRET_RETIRED");
  });

  it("fails closed when a retired key collides with the current version", () => {
    expect(() =>
      parseDataPlaneConfig({
        ...validDataPlane,
        PAT_HASH_KEY_VERSION: "1",
        PAT_HASH_SECRET_RETIRED: JSON.stringify({
          "1": "another-pat-hash-secret-32chars-long!",
        }),
      }),
    ).toThrow("PAT_HASH_SECRET_RETIRED version collision");
  });
  it("fails closed when the upstream key is missing", () => {
    const rest = { ...validDataPlane };
    delete (rest as Record<string, string>).SCULPIN_UPSTREAM_API_KEY;
    expect(() => parseDataPlaneConfig(rest)).toThrow("SCULPIN_UPSTREAM_API_KEY");
  });
  it("rejects a short PAT hash secret", () => {
    expect(() =>
      parseDataPlaneConfig({ ...validDataPlane, PAT_HASH_SECRET: "too-short" }),
    ).toThrow("PAT_HASH_SECRET");
  });
  it("rejects a non-http Sculpin upstream URL", () => {
    expect(() =>
      parseDataPlaneConfig({
        ...validDataPlane,
        SCULPIN_UPSTREAM_URL: "ftp://sculpin.internal",
      }),
    ).toThrow("SCULPIN_UPSTREAM_URL");
  });
  it("requires a secure non-local public URL in production", () => {
    expect(() =>
      parseDataPlaneConfig({
        ...validDataPlane,
        NODE_ENV: "production",
        HUB_PUBLIC_URL: "http://localhost:3002",
      }),
    ).toThrow("HUB_PUBLIC_URL production safety");
    expect(
      parseDataPlaneConfig({
        ...validDataPlane,
        NODE_ENV: "production",
        HUB_PUBLIC_URL: "https://hub.example.com",
      }).hubPublicUrl,
    ).toBe("https://hub.example.com");
  });
  it("does not echo secret values in errors", () => {
    let message = "";
    try {
      parseDataPlaneConfig({
        ...validDataPlane,
        HUB_PUBLIC_URL: "not a url",
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("HUB_PUBLIC_URL");
    expect(message).not.toContain(validDataPlane.SCULPIN_UPSTREAM_API_KEY);
    expect(message).not.toContain(validDataPlane.PAT_HASH_SECRET);
  });
});

describe("discovery configuration", () => {
  const validDiscovery = {
    SCULPIN_UPSTREAM_URL: "http://sculpin.internal:8001",
    SCULPIN_DISCOVERY_API_KEY: "sk-discovery-canary-secret",
  };
  it("parses a complete discovery environment", () => {
    const config = parseDiscoveryConfig(validDiscovery);
    expect(config.sculpinUpstreamUrl).toBe("http://sculpin.internal:8001");
    expect(config.sculpinDiscoveryApiKey).toBe("sk-discovery-canary-secret");
  });
  it("fails closed when the discovery key is missing", () => {
    const rest = { ...validDiscovery };
    delete (rest as Record<string, string>).SCULPIN_DISCOVERY_API_KEY;
    expect(() => parseDiscoveryConfig(rest)).toThrow(
      "SCULPIN_DISCOVERY_API_KEY",
    );
  });
  it("rejects a non-http Sculpin upstream URL", () => {
    expect(() =>
      parseDiscoveryConfig({
        ...validDiscovery,
        SCULPIN_UPSTREAM_URL: "ftp://sculpin.internal",
      }),
    ).toThrow("SCULPIN_UPSTREAM_URL");
  });
  it("does not echo the discovery key in errors", () => {
    let message = "";
    try {
      parseDiscoveryConfig({
        ...validDiscovery,
        SCULPIN_UPSTREAM_URL: "not a url",
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("SCULPIN_UPSTREAM_URL");
    expect(message).not.toContain(validDiscovery.SCULPIN_DISCOVERY_API_KEY);
  });
});
