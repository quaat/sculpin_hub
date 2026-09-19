import { describe, expect, it, vi } from "vitest";
import {
  CreatePersonalTenantService,
  DomainValidationError,
  toPublicModel,
  validateCatalogueEntryInput,
  validateCreatePersonalTenantCommand,
  type CatalogueEntry,
  type CatalogueEntryInput,
} from "./index.js";

const valid = {
  normalizedEmail: "user@example.com",
  displayName: "Example User",
  locale: "en-US",
  organizationSlug: "example-user",
  requestId: "req_123",
  identity: {
    provider: "google",
    providerSubject: "sub-123",
    providerEmail: "user@example.com",
    emailVerified: true,
    metadata: { schemaVersion: 1 as const, issuer: "accounts.google.com" },
  },
};

describe("personal tenant command validation", () => {
  it("accepts a valid command", () =>
    expect(() => validateCreatePersonalTenantCommand(valid)).not.toThrow());
  it.each([
    ["email", { normalizedEmail: "User@example.com" }],
    ["slug", { organizationSlug: "Bad_Slug" }],
    ["display name", { displayName: "" }],
    ["locale", { locale: "english" }],
    ["request id", { requestId: "bad space" }],
  ])("rejects invalid %s", (_name, patch) =>
    expect(() =>
      validateCreatePersonalTenantCommand({ ...valid, ...patch }),
    ).toThrow(DomainValidationError),
  );
  it("rejects nested sensitive identity metadata", () =>
    expect(() =>
      validateCreatePersonalTenantCommand({
        ...valid,
        identity: {
          ...valid.identity,
          metadata: {
            schemaVersion: 1,
            issuer: "ok",
            nested: { access_token: "secret" },
          } as never,
        },
      }),
    ).toThrow(DomainValidationError));
  it("does not call the transaction after validation failure", async () => {
    const tx = { create: vi.fn() };
    await expect(
      new CreatePersonalTenantService(tx).execute({
        ...valid,
        requestId: "bad value",
      }),
    ).rejects.toThrow(DomainValidationError);
    expect(tx.create).not.toHaveBeenCalled();
  });
});

const validCatalogue: CatalogueEntryInput = {
  publicAlias: "sculpin-fast",
  upstreamAgentId: "agent-42",
  displayName: "Sculpin Fast",
  description: "A fast Sculpin agent.",
};

describe("catalogue entry validation", () => {
  it("accepts a valid input", () =>
    expect(() => validateCatalogueEntryInput(validCatalogue)).not.toThrow());
  it("accepts input without a description", () =>
    expect(() =>
      validateCatalogueEntryInput({
        publicAlias: "a",
        upstreamAgentId: "x",
        displayName: "A",
      }),
    ).not.toThrow());
  it.each([
    ["uppercase alias", { publicAlias: "Sculpin" }],
    ["alias with space", { publicAlias: "sculpin fast" }],
    ["alias with slash", { publicAlias: "sculpin/fast" }],
    ["alias starting with dot", { publicAlias: ".sculpin" }],
    ["empty alias", { publicAlias: "" }],
    ["empty agent id", { upstreamAgentId: "" }],
    ["untrimmed agent id", { upstreamAgentId: " agent-42 " }],
    ["control char in agent id", { upstreamAgentId: "agent\t42" }],
    ["empty display name", { displayName: "" }],
    ["blank display name", { displayName: "   " }],
    ["control char in description", { description: "line\nbreak" }],
  ])("rejects %s", (_name, patch) =>
    expect(() =>
      validateCatalogueEntryInput({ ...validCatalogue, ...patch }),
    ).toThrow(DomainValidationError),
  );
  it("rejects an alias longer than 64 characters", () =>
    expect(() =>
      validateCatalogueEntryInput({
        ...validCatalogue,
        publicAlias: "a".repeat(65),
      }),
    ).toThrow(DomainValidationError));
});

describe("toPublicModel", () => {
  const entry: CatalogueEntry = {
    id: "11111111-1111-4111-8111-111111111111",
    publicAlias: "sculpin-fast",
    upstreamAgentId: "internal-secret-agent",
    displayName: "Sculpin Fast",
    description: "desc",
    status: "published",
    version: 3,
  };
  it("exposes only the public alias, name, and description", () => {
    const model = toPublicModel(entry);
    expect(model).toEqual({
      id: "sculpin-fast",
      displayName: "Sculpin Fast",
      description: "desc",
    });
  });
  it("never leaks the upstream agent id or internal fields", () => {
    const serialized = JSON.stringify(toPublicModel(entry));
    expect(serialized).not.toContain("internal-secret-agent");
    expect(serialized).not.toContain("upstreamAgentId");
    expect(Object.keys(toPublicModel(entry)).sort()).toEqual([
      "description",
      "displayName",
      "id",
    ]);
  });
  it("omits description when absent", () => {
    const { description: _omit, ...withoutDescription } = entry;
    void _omit;
    const model = toPublicModel(withoutDescription);
    expect(model).toEqual({ id: "sculpin-fast", displayName: "Sculpin Fast" });
    expect("description" in model).toBe(false);
  });
});
