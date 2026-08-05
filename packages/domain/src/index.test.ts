import { describe, expect, it, vi } from "vitest";
import {
  CreatePersonalTenantService,
  DomainValidationError,
  validateCreatePersonalTenantCommand,
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
