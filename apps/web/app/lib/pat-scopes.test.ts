import { describe, expect, it, vi } from "vitest";
import type {
  CatalogueOfferingSummary,
  CatalogueRepository,
  Subscription,
  SubscriptionRepository,
} from "@sculpin/domain";
import { resolveScopableOfferings, resolveScopeLabels } from "./pat-scopes";
import type {
  AuthzDeps,
  CanonicalMembership,
  CanonicalOrganization,
  Session,
} from "./session";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const PRO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FAST = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DRAFT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NOW = new Date("2026-09-20T00:00:00.000Z");

function authz(): Partial<AuthzDeps> {
  const organization: CanonicalOrganization = {
    id: ORG_ID,
    slug: "p-org",
    type: "personal",
    status: "active",
  };
  const membership: CanonicalMembership = { role: "owner", status: "active" };
  return {
    loadSession: () =>
      Promise.resolve({ user: { id: USER_ID } } as unknown as Session),
    store: {
      loadUserById: () =>
        Promise.resolve({
          id: USER_ID,
          role: "user" as const,
          status: "active" as const,
          normalizedEmail: "user@example.com",
          displayName: "User",
        }),
      loadOrgWithMembership: () => Promise.resolve({ organization, membership }),
    },
  };
}

function sub(offerings: readonly string[]): Subscription {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    organizationId: ORG_ID,
    planId: "44444444-4444-4444-8444-444444444444",
    planKey: "free-trial",
    planKind: "free_trial",
    status: "active",
    quotaLimit: 200,
    quotaUsed: 0,
    startsAt: new Date("2026-09-01T00:00:00.000Z"),
    offerings: [...offerings],
    version: 1,
  };
}

function subscriptionsWith(
  subs: readonly Subscription[],
): SubscriptionRepository {
  return {
    listForOrganization: vi.fn().mockResolvedValue(subs),
    grantFromPlan: vi.fn(),
    reserveQuota: vi.fn(),
    setStatus: vi.fn(),
  } as unknown as SubscriptionRepository;
}

function catalogueWith(
  summaries: readonly CatalogueOfferingSummary[],
): CatalogueRepository {
  return {
    listSummariesByIds: vi
      .fn()
      .mockImplementation((ids: readonly string[]) =>
        Promise.resolve(summaries.filter((s) => ids.includes(s.catalogueEntryId))),
      ),
  } as unknown as CatalogueRepository;
}

const summaries: readonly CatalogueOfferingSummary[] = [
  { catalogueEntryId: PRO, publicAlias: "sculpin-pro", displayName: "Sculpin Pro", status: "published" },
  { catalogueEntryId: FAST, publicAlias: "sculpin-fast", displayName: "Sculpin Fast", status: "disabled" },
  { catalogueEntryId: DRAFT, publicAlias: "sculpin-draft", displayName: "Sculpin Draft", status: "draft" },
];

describe("resolveScopableOfferings", () => {
  it("returns only offerings that are BOTH published AND entitled", async () => {
    // Entitled to PRO (published), FAST (disabled) and DRAFT (draft) — only the
    // published one is scopable.
    const result = await resolveScopableOfferings({
      authz: authz(),
      resolvePersonalOrganizationId: () => Promise.resolve(ORG_ID),
      subscriptions: subscriptionsWith([sub([PRO, FAST, DRAFT])]),
      catalogue: catalogueWith(summaries),
      now: () => NOW,
    });
    expect(result.map((r) => r.publicAlias)).toEqual(["sculpin-pro"]);
  });

  it("excludes a published offering the caller is NOT entitled to", async () => {
    const result = await resolveScopableOfferings({
      authz: authz(),
      resolvePersonalOrganizationId: () => Promise.resolve(ORG_ID),
      // Entitled to nothing that is published (only the disabled one).
      subscriptions: subscriptionsWith([sub([FAST])]),
      catalogue: catalogueWith(summaries),
      now: () => NOW,
    });
    expect(result).toEqual([]);
  });

  it("returns nothing when there is no active entitlement", async () => {
    const result = await resolveScopableOfferings({
      authz: authz(),
      resolvePersonalOrganizationId: () => Promise.resolve(ORG_ID),
      subscriptions: subscriptionsWith([]),
      catalogue: catalogueWith(summaries),
      now: () => NOW,
    });
    expect(result).toEqual([]);
  });
});

describe("resolveScopeLabels", () => {
  it("maps stored scope ids to 'Display name (alias)' regardless of status", async () => {
    const labels = await resolveScopeLabels([PRO, FAST], {
      catalogue: catalogueWith(summaries),
    });
    expect(labels.get(PRO)).toBe("Sculpin Pro (sculpin-pro)");
    // A disabled offering still labels a historical scope.
    expect(labels.get(FAST)).toBe("Sculpin Fast (sculpin-fast)");
  });

  it("returns an empty map for no scope ids (no DB round trip)", async () => {
    const listSummariesByIds = vi.fn().mockResolvedValue([]);
    const catalogue = { listSummariesByIds } as unknown as CatalogueRepository;
    const labels = await resolveScopeLabels([], { catalogue });
    expect(labels.size).toBe(0);
    expect(listSummariesByIds).not.toHaveBeenCalled();
  });
});
