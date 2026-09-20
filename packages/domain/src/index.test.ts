import { describe, expect, it, vi } from "vitest";
import {
  assertSubscriptionTransition,
  authorizedCatalogueEntryIds,
  canTransitionSubscription,
  CreatePersonalTenantService,
  DomainValidationError,
  formatPatToken,
  isSubscriptionActive,
  narrowOfferingsToPatScopes,
  parseDiscoveredAgents,
  parsePatToken,
  resolveEntitlement,
  stableDiscoveredAgentIds,
  toPublicModel,
  validateCatalogueEntryInput,
  validateCreatePersonalTenantCommand,
  validatePatName,
  validatePatScopeIds,
  validatePlanInput,
  validatePlanPatch,
  validateQuotaAmount,
  PAT_MAX_SCOPES,
  PAT_PREFIX,
  PAT_PUBLIC_ID_LENGTH,
  PAT_SECRET_LENGTH,
  type CatalogueEntry,
  type CatalogueEntryInput,
  type PlanInput,
  type PlanPatch,
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
const AGENT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AGENT_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function sub(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    organizationId: ORG,
    planId: "44444444-4444-4444-8444-444444444444",
    planKey: "free-trial",
    planKind: "free_trial",
    status: "active",
    quotaLimit: 200,
    quotaUsed: 0,
    startsAt: new Date("2026-09-01T00:00:00.000Z"),
    offerings: [],
    version: 1,
    ...overrides,
  };
}

const validPlan: PlanInput = {
  key: "commercial-monthly",
  name: "Commercial Monthly",
  description: "A monthly commercial plan.",
  kind: "commercial_monthly",
  requestQuota: 10_000,
  durationDays: 30,
};

describe("validatePlanInput", () => {
  it("accepts a valid plan", () =>
    expect(() => validatePlanInput(validPlan)).not.toThrow());
  it("accepts a plan without a duration (open-ended)", () => {
    const { durationDays: _omit, ...openEnded } = validPlan;
    void _omit;
    expect(() => validatePlanInput(openEnded)).not.toThrow();
  });
  it("accepts a zero request quota", () =>
    expect(() =>
      validatePlanInput({ ...validPlan, requestQuota: 0 }),
    ).not.toThrow());
  it.each<[string, Partial<PlanInput>]>([
    ["uppercase key", { key: "Commercial" }],
    ["key with underscore", { key: "free_trial" }],
    ["key with space", { key: "free trial" }],
    ["empty key", { key: "" }],
    ["blank name", { name: "   " }],
    ["empty name", { name: "" }],
    ["unknown kind", { kind: "premium" as PlanInput["kind"] }],
    ["negative quota", { requestQuota: -1 }],
    ["fractional quota", { requestQuota: 1.5 }],
    ["quota over cap", { requestQuota: 1_000_001 }],
    ["zero duration", { durationDays: 0 }],
    ["fractional duration", { durationDays: 1.5 }],
    ["duration over cap", { durationDays: 3651 }],
    ["control char in description", { description: "line\nbreak" }],
  ])("rejects %s", (_label, patch) =>
    expect(() => validatePlanInput({ ...validPlan, ...patch })).toThrow(
      DomainValidationError,
    ),
  );
  it("rejects a name longer than 120 characters", () =>
    expect(() =>
      validatePlanInput({ ...validPlan, name: "n".repeat(121) }),
    ).toThrow(DomainValidationError));
  it("rejects a description longer than 2048 characters", () =>
    expect(() =>
      validatePlanInput({ ...validPlan, description: "d".repeat(2049) }),
    ).toThrow(DomainValidationError));
});

describe("validatePlanPatch", () => {
  it("accepts an empty patch", () =>
    expect(() => validatePlanPatch({})).not.toThrow());
  it("accepts clearing the duration window with null", () =>
    expect(() => validatePlanPatch({ durationDays: null })).not.toThrow());
  it("accepts valid mutable fields", () =>
    expect(() =>
      validatePlanPatch({
        name: "Renamed",
        description: "New copy.",
        requestQuota: 500,
        durationDays: 90,
        selfServiceEligible: true,
        adminGrantable: false,
        oneTimePerOrganization: true,
      }),
    ).not.toThrow());
  it.each<[string, PlanPatch]>([
    ["empty name", { name: "" }],
    ["blank name", { name: "   " }],
    ["name over 120", { name: "n".repeat(121) }],
    ["description over 2048", { description: "d".repeat(2049) }],
    ["control char in description", { description: "a\nb" }],
    ["negative quota", { requestQuota: -1 }],
    ["fractional quota", { requestQuota: 2.5 }],
    ["quota over cap", { requestQuota: 1_000_001 }],
    ["zero duration", { durationDays: 0 }],
    ["fractional duration", { durationDays: 1.5 }],
    ["duration over cap", { durationDays: 3651 }],
    [
      "non-boolean flag",
      { selfServiceEligible: "yes" as unknown as boolean },
    ],
  ])("rejects %s", (_label, patch) =>
    expect(() => validatePlanPatch(patch)).toThrow(DomainValidationError),
  );
});

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
  it.each<SubscriptionStatus>(["suspended", "canceled", "expired"])(
    "is inactive when status is %s",
    (status) => expect(isSubscriptionActive(sub({ status }), NOW)).toBe(false),
  );
});

describe("resolveEntitlement", () => {
  it("is inactive with no subscriptions", () =>
    expect(resolveEntitlement(ORG, [], NOW)).toEqual({
      organizationId: ORG,
      active: false,
      planKeys: [],
      remainingQuota: 0,
      entitledCatalogueEntryIds: [],
    }));
  it("ignores terminal, suspended, and out-of-window subscriptions", () => {
    const entitlement = resolveEntitlement(
      ORG,
      [
        sub({ status: "canceled", quotaLimit: 500, offerings: [AGENT_A] }),
        sub({ status: "suspended", quotaLimit: 500, offerings: [AGENT_B] }),
        sub({
          endsAt: new Date("2026-09-01T00:00:00.000Z"),
          quotaLimit: 500,
          offerings: [AGENT_C],
        }),
      ],
      NOW,
    );
    expect(entitlement.active).toBe(false);
    expect(entitlement.remainingQuota).toBe(0);
    expect(entitlement.entitledCatalogueEntryIds).toEqual([]);
  });
  it("unions plan keys, pooled quota, and offerings across active subscriptions", () => {
    const entitlement = resolveEntitlement(
      ORG,
      [
        sub({
          planKey: "free-trial",
          quotaLimit: 200,
          quotaUsed: 150,
          offerings: [AGENT_B, AGENT_A],
        }),
        sub({
          planKey: "commercial-monthly",
          quotaLimit: 1000,
          quotaUsed: 100,
          offerings: [AGENT_B, AGENT_C],
        }),
      ],
      NOW,
    );
    expect(entitlement.active).toBe(true);
    expect(entitlement.planKeys).toEqual(["commercial-monthly", "free-trial"]);
    expect(entitlement.remainingQuota).toBe(50 + 900);
    expect(entitlement.entitledCatalogueEntryIds).toEqual([
      AGENT_A,
      AGENT_B,
      AGENT_C,
    ]);
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
  it("allows active → suspended/canceled/expired", () => {
    expect(canTransitionSubscription("active", "suspended")).toBe(true);
    expect(canTransitionSubscription("active", "canceled")).toBe(true);
    expect(canTransitionSubscription("active", "expired")).toBe(true);
  });
  it("allows suspended → active/canceled/expired (resume)", () => {
    expect(canTransitionSubscription("suspended", "active")).toBe(true);
    expect(canTransitionSubscription("suspended", "canceled")).toBe(true);
    expect(canTransitionSubscription("suspended", "expired")).toBe(true);
  });
  it.each<[SubscriptionStatus, SubscriptionStatus]>([
    ["active", "active"],
    ["suspended", "suspended"],
    ["canceled", "active"],
    ["canceled", "suspended"],
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

describe("PAT token format", () => {
  const publicId = "A".repeat(PAT_PUBLIC_ID_LENGTH);
  const secret = "b".repeat(PAT_SECRET_LENGTH);
  const token = `${PAT_PREFIX}${publicId}_${secret}`;

  it("round-trips format → parse", () => {
    expect(formatPatToken(publicId, secret)).toBe(token);
    expect(parsePatToken(token)).toEqual({ publicId, secret });
  });

  it("formats only valid parts", () => {
    expect(() => formatPatToken("short", secret)).toThrow(DomainValidationError);
    expect(() => formatPatToken(publicId, "short")).toThrow(
      DomainValidationError,
    );
  });

  it.each([
    ["missing prefix", `${publicId}_${secret}`],
    ["wrong prefix", `sclp_key_${publicId}_${secret}`],
    ["no separator", `${PAT_PREFIX}${publicId}${secret}`],
    ["empty public id", `${PAT_PREFIX}_${secret}`],
    ["short public id", `${PAT_PREFIX}AAAA_${secret}`],
    ["short secret", `${PAT_PREFIX}${publicId}_bbbb`],
    ["non-base62 public id", `${PAT_PREFIX}${"-".repeat(22)}_${secret}`],
    ["non-base62 secret", `${PAT_PREFIX}${publicId}_${"-".repeat(43)}`],
    ["empty", ""],
  ])("rejects %s as undefined (no oracle)", (_label, raw) => {
    expect(parsePatToken(raw)).toBeUndefined();
  });

  it("ignores extra underscores in the secret segment only via the first split", () => {
    // The remainder is split on the FIRST underscore; a secret can't contain
    // '_' (not base62), so any embedded '_' makes the whole token invalid.
    expect(parsePatToken(`${PAT_PREFIX}${publicId}_${secret}_extra`)).toBeUndefined();
  });
});

describe("validatePatName", () => {
  it("accepts a printable 1-120 char name", () => {
    expect(() => validatePatName("My laptop")).not.toThrow();
    expect(() => validatePatName("x")).not.toThrow();
    expect(() => validatePatName("y".repeat(120))).not.toThrow();
  });
  it.each([
    ["empty", ""],
    ["blank", "   "],
    ["too long", "z".repeat(121)],
    ["control char", "bad\u0007name"],
  ])("rejects %s", (_label, name) =>
    expect(() => validatePatName(name)).toThrow(DomainValidationError),
  );
});

const CE = (n: string) =>
  `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;

describe("validatePatScopeIds", () => {
  const A = CE("a");
  const B = CE("b");
  it("accepts an empty list (unscoped) and a bounded list of uuids", () => {
    expect(() => validatePatScopeIds([])).not.toThrow();
    expect(() => validatePatScopeIds([A, B])).not.toThrow();
  });
  it("rejects a non-uuid id", () => {
    expect(() => validatePatScopeIds(["not-a-uuid"])).toThrow(
      DomainValidationError,
    );
  });
  it("rejects duplicates", () => {
    expect(() => validatePatScopeIds([A, A])).toThrow(DomainValidationError);
  });
  it("rejects more than the cap", () => {
    const many = Array.from(
      { length: PAT_MAX_SCOPES + 1 },
      (_, i) =>
        `${i.toString(16).padStart(8, "0").slice(0, 8)}-0000-4000-8000-000000000000`,
    );
    expect(() => validatePatScopeIds(many)).toThrow(DomainValidationError);
  });
});

describe("narrowOfferingsToPatScopes", () => {
  const A = CE("a");
  const B = CE("b");
  const C = CE("c");
  it("passes the entitlement through unchanged when unscoped", () => {
    const entitled = [B, A];
    expect(narrowOfferingsToPatScopes([], entitled)).toBe(entitled);
  });
  it("returns the sorted intersection when scoped", () => {
    expect(narrowOfferingsToPatScopes([B, A], [A, B, C])).toEqual(
      [A, B].sort(),
    );
  });
  it("drops a scope naming a non-entitled entry (a PAT can only narrow)", () => {
    expect(narrowOfferingsToPatScopes([A, C], [A, B])).toEqual([A]);
  });
  it("is order-independent", () => {
    expect(narrowOfferingsToPatScopes([C, A, B], [B, C, A])).toEqual(
      [A, B, C].sort(),
    );
  });
  it("yields nothing when no scope is entitled", () => {
    expect(narrowOfferingsToPatScopes([C], [A, B])).toEqual([]);
  });
});

describe("authorizedCatalogueEntryIds", () => {
  const A = CE("a");
  const B = CE("b");
  const C = CE("c");
  it("an unscoped PAT authorizes all entitled offerings", () => {
    const set = authorizedCatalogueEntryIds([A, B], []);
    expect([...set].sort()).toEqual([A, B].sort());
  });
  it("a scoped PAT authorizes only the intersection", () => {
    const set = authorizedCatalogueEntryIds([A, B], [A]);
    expect([...set]).toEqual([A]);
    expect(set.has(B)).toBe(false);
  });
  it("a scope naming a non-entitled entry never grants more than entitled", () => {
    const set = authorizedCatalogueEntryIds([A, B], [A, C]);
    expect([...set]).toEqual([A]);
    expect(set.has(C)).toBe(false);
  });
  it("empty offerings yield an empty set (fail closed)", () => {
    expect(authorizedCatalogueEntryIds([], [A]).size).toBe(0);
  });
  it("an unscoped PAT with empty offerings yields an empty set", () => {
    expect(authorizedCatalogueEntryIds([], []).size).toBe(0);
  });
});

describe("parseDiscoveredAgents", () => {
  const UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const UUID2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  function modelList(data: unknown[]): unknown {
    return { object: "list", data };
  }

  it("parses a well-formed list emitting slug + uuid rows for each agent", () => {
    const agents = parseDiscoveredAgents(
      modelList([
        { id: "support", object: "model", created: 1720000000, owned_by: "exodus" },
        { id: UUID, object: "model", created: 1720000000, owned_by: "exodus" },
      ]),
    );
    expect(agents).toEqual([
      { id: "support", agentId: "support", isUuid: false, ownedBy: "exodus" },
      { id: UUID, agentId: UUID, isUuid: true, ownedBy: "exodus" },
    ]);
  });

  it("classifies uuid-form vs slug-form ids", () => {
    const agents = parseDiscoveredAgents(
      modelList([
        { id: UUID, object: "model", owned_by: "exodus" },
        { id: "help-desk", object: "model", owned_by: "exodus" },
        { id: "not-a-uuid-1234", object: "model", owned_by: "exodus" },
      ]),
    );
    expect(agents.map((a) => a.isUuid)).toEqual([true, false, false]);
    expect(stableDiscoveredAgentIds(agents)).toEqual(new Set([UUID]));
  });

  it("keeps the STABLE-ALIAS rule: only uuid-form rows are stable targets", () => {
    const agents = parseDiscoveredAgents(
      modelList([
        { id: "support", owned_by: "exodus" },
        { id: UUID, owned_by: "exodus" },
        { id: "billing", owned_by: "exodus" },
        { id: UUID2, owned_by: "exodus" },
      ]),
    );
    expect(stableDiscoveredAgentIds(agents)).toEqual(new Set([UUID, UUID2]));
  });

  it("surfaces a single-appearance agent (uuid-only or slug-only)", () => {
    const uuidOnly = parseDiscoveredAgents(
      modelList([{ id: UUID, owned_by: "exodus" }]),
    );
    expect(uuidOnly).toHaveLength(1);
    expect(uuidOnly[0]?.isUuid).toBe(true);
    const slugOnly = parseDiscoveredAgents(
      modelList([{ id: "lonely-slug", owned_by: "exodus" }]),
    );
    expect(slugOnly[0]?.isUuid).toBe(false);
    // A slug-only agent is NOT a stable target: fail-closed for catalogue use.
    expect(stableDiscoveredAgentIds(slugOnly).size).toBe(0);
  });

  it("de-duplicates repeated ids preserving first occurrence", () => {
    const agents = parseDiscoveredAgents(
      modelList([
        { id: "support", owned_by: "exodus" },
        { id: "support", owned_by: "exodus" },
      ]),
    );
    expect(agents).toHaveLength(1);
  });

  it("tolerates a missing / non-string owned_by (empty string)", () => {
    const agents = parseDiscoveredAgents(modelList([{ id: "support" }]));
    expect(agents[0]?.ownedBy).toBe("");
  });

  it.each([
    ["null", null],
    ["a string", "list"],
    ["missing object", { data: [] }],
    ["wrong object", { object: "models", data: [{ id: "x" }] }],
    ["non-array data", { object: "list", data: {} }],
    ["empty data", { object: "list", data: [] }],
  ])("fails closed on %s", (_name, payload) => {
    expect(() => parseDiscoveredAgents(payload)).toThrow(DomainValidationError);
  });

  it.each([
    ["non-object entry", [42]],
    ["missing id", [{ object: "model", owned_by: "exodus" }]],
    ["empty id", [{ id: "", owned_by: "exodus" }]],
    ["non-string id", [{ id: 123, owned_by: "exodus" }]],
  ])("fails closed on a malformed entry: %s", (_name, data) => {
    expect(() =>
      parseDiscoveredAgents({ object: "list", data }),
    ).toThrow(DomainValidationError);
  });
});
