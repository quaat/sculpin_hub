import { describe, expect, it, vi } from "vitest";
import {
  assertSubscriptionTransition,
  canTransitionSubscription,
  CreatePersonalTenantService,
  DomainValidationError,
  isSubscriptionActive,
  resolveEntitlement,
  toPublicModel,
  validateCatalogueEntryInput,
  validateCreatePersonalTenantCommand,
  validateQuotaAmount,
  type CatalogueEntry,
  type CatalogueEntryInput,
  type Subscription,
  type SubscriptionStatus,
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

const ORG = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-09-19T00:00:00.000Z");

function sub(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    organizationId: ORG,
    plan: "trial",
    status: "active",
    quotaLimit: 200,
    quotaUsed: 0,
    startsAt: new Date("2026-09-01T00:00:00.000Z"),
    version: 1,
    ...overrides,
  };
}

describe("isSubscriptionActive", () => {
  it("is active when status active and open-ended", () =>
    expect(isSubscriptionActive(sub(), NOW)).toBe(true));
  it("is active when status active and ends in the future", () =>
    expect(
      isSubscriptionActive(
        sub({ endsAt: new Date("2026-09-20T00:00:00.000Z") }),
        NOW,
      ),
    ).toBe(true));
  it("is inactive when ended in the past", () =>
    expect(
      isSubscriptionActive(
        sub({ endsAt: new Date("2026-09-18T00:00:00.000Z") }),
        NOW,
      ),
    ).toBe(false));
  it.each<SubscriptionStatus>(["canceled", "expired"])(
    "is inactive when status is %s",
    (status) => expect(isSubscriptionActive(sub({ status }), NOW)).toBe(false),
  );
});

describe("resolveEntitlement", () => {
  it("is inactive with no subscriptions", () =>
    expect(resolveEntitlement(ORG, [], NOW)).toEqual({
      organizationId: ORG,
      active: false,
      plans: [],
      remainingQuota: 0,
    }));
  it("ignores terminal and out-of-window subscriptions", () => {
    const entitlement = resolveEntitlement(
      ORG,
      [
        sub({ status: "canceled", quotaLimit: 500, quotaUsed: 0 }),
        sub({ endsAt: new Date("2026-09-01T00:00:00.000Z"), quotaLimit: 500 }),
      ],
      NOW,
    );
    expect(entitlement.active).toBe(false);
    expect(entitlement.remainingQuota).toBe(0);
  });
  it("pools remaining quota across the union of active subscriptions", () => {
    const entitlement = resolveEntitlement(
      ORG,
      [
        sub({ plan: "trial", quotaLimit: 200, quotaUsed: 150 }),
        sub({ plan: "commercial", quotaLimit: 1000, quotaUsed: 100 }),
      ],
      NOW,
    );
    expect(entitlement.active).toBe(true);
    expect(entitlement.plans).toEqual(["commercial", "trial"]);
    expect(entitlement.remainingQuota).toBe(50 + 900);
  });
  it("clamps a negative per-subscription remainder to zero", () =>
    expect(
      resolveEntitlement(
        ORG,
        [sub({ quotaLimit: 200, quotaUsed: 250 })],
        NOW,
      ).remainingQuota,
    ).toBe(0));
});

describe("subscription state machine", () => {
  it("allows active → canceled and active → expired", () => {
    expect(canTransitionSubscription("active", "canceled")).toBe(true);
    expect(canTransitionSubscription("active", "expired")).toBe(true);
  });
  it.each<[SubscriptionStatus, SubscriptionStatus]>([
    ["active", "active"],
    ["canceled", "active"],
    ["expired", "active"],
    ["canceled", "expired"],
    ["expired", "canceled"],
  ])("forbids %s → %s", (from, to) => {
    expect(canTransitionSubscription(from, to)).toBe(false);
    expect(() => assertSubscriptionTransition(from, to)).toThrow(
      DomainValidationError,
    );
  });
});

describe("validateQuotaAmount", () => {
  it("accepts a positive integer within bounds", () =>
    expect(() => validateQuotaAmount(1)).not.toThrow());
  it.each([0, -1, 1.5, 1001, Number.NaN])("rejects %s", (amount) =>
    expect(() => validateQuotaAmount(amount)).toThrow(DomainValidationError),
  );
});
