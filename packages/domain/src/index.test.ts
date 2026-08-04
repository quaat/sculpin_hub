import { describe, expect, it, vi } from "vitest";
import { CreatePersonalTenantService, DomainValidationError } from "./index.js";

describe("CreatePersonalTenantService", () => {
  it("rejects non-normalized email before starting a transaction", async () => {
    const create = vi.fn();
    const service = new CreatePersonalTenantService({ create });
    expect(() =>
      service.execute({
        normalizedEmail: "User@Example.com",
        displayName: "User",
        locale: "en",
        organizationSlug: "user",
        requestId: "request",
      }),
    ).toThrow(DomainValidationError);
    expect(create).not.toHaveBeenCalled();
  });
});
