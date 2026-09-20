import { describe, expect, it, vi } from "vitest";
import type {
  Plan,
  PlanRepository,
  Subscription,
  SubscriptionRepository,
} from "@sculpin/domain";
import {
  AdminGrantError,
  SelfServiceClaimError,
  SubscriptionInputError,
  adminGrantPlan,
  adminSetSubscriptionStatus,
  claimSelfServicePlan,
  claimSelfServicePlanForCaller,
  listCallerSubscriptions,
  listOrganizationSubscriptions,
  listSelfServicePlans,
  resolveCallerPersonalOrganizationId,
} from "./subscription";
import { AuthzError, type AuthzDeps, type Session } from "./session";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ADMIN_ID = "22222222-2222-4222-8222-222222222222";
const ORG_ID = "33333333-3333-4333-8333-333333333333";
const PLAN_ID = "44444444-4444-4444-8444-444444444444";
const SUB_ID = "55555555-5555-4555-8555-555555555555";

/**
 * Build an injectable authz that resolves the caller as a MEMBER (owner) of
 * `ORG_ID`, a non-member USER, an ADMIN (no org membership needed), or an
 * unauthenticated caller. Nothing here touches a database.
 */
function authzFor(role: "member" | "user" | "admin" | "none"): Partial<AuthzDeps> {
  if (role === "none") {
    return {
      loadSession: () => Promise.resolve(null),
      store: {
        loadUserById: () => Promise.resolve(null),
        loadOrgWithMembership: () =>
          Promise.resolve({ organization: null, membership: null }),
      },
    };
  }
  const id = role === "admin" ? ADMIN_ID : USER_ID;
  const platformRole = role === "admin" ? "admin" : "user";
  return {
    loadSession: () =>
      Promise.resolve({ user: { id } } as unknown as Session),
    store: {
      loadUserById: () =>
        Promise.resolve({
          id,
          role: platformRole,
          status: "active" as const,
          normalizedEmail: "person@example.com",
          displayName: "Person",
        }),
      loadOrgWithMembership: (organizationId: string, userId: string) => {
        // ORG_ID always resolves as an active org; only the plain member holds
        // an active membership. An authenticated non-member "user" therefore
        // reaches the membership check and fails closed with `not_a_member` —
        // proving the membership gate itself, not just an org miss.
        if (organizationId !== ORG_ID) {
          return Promise.resolve({ organization: null, membership: null });
        }
        const organization = {
          id: ORG_ID,
          slug: "person",
          type: "personal" as const,
          status: "active" as const,
        };
        if (role === "member" && userId === id) {
          return Promise.resolve({
            organization,
            membership: { role: "owner" as const, status: "active" as const },
          });
        }
        return Promise.resolve({ organization, membership: null });
      },
    },
  };
}

function mockPlanRepository() {
  return {
    create: vi.fn(),
    update: vi.fn(),
    setEnabled: vi.fn(),
    setPublished: vi.fn(),
    attachCatalogueEntry: vi.fn(),
    detachCatalogueEntry: vi.fn(),
    listAll: vi.fn(),
    listSelfServicePublished: vi.fn(),
    findById: vi.fn(),
    findByKey: vi.fn(),
  };
}

function mockSubscriptionRepository() {
  return {
    listForOrganization: vi.fn(),
    grantFromPlan: vi.fn(),
    reserveQuota: vi.fn(),
    setStatus: vi.fn(),
  };
}

function planWith(overrides: Partial<Plan>): Plan {
  return {
    id: PLAN_ID,
    key: "free-trial",
    name: "Free Trial",
    kind: "free_trial",
    enabled: true,
    published: true,
    selfServiceEligible: true,
    adminGrantable: true,
    requestQuota: 100,
    oneTimePerOrganization: true,
    version: 1,
    catalogueEntryIds: [],
    ...overrides,
  };
}

const sampleSubscription: Subscription = {
  id: SUB_ID,
  organizationId: ORG_ID,
  planId: PLAN_ID,
  planKey: "free-trial",
  planKind: "free_trial",
  status: "active",
  quotaLimit: 100,
  quotaUsed: 0,
  startsAt: new Date("2026-01-01T00:00:00Z"),
  offerings: [],
  version: 1,
};

async function reasonOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AuthzError);
    return (error as AuthzError).reason;
  }
  throw new Error("expected AuthzError to be thrown");
}

async function claimReasonOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(SelfServiceClaimError);
    return (error as SelfServiceClaimError).reason;
  }
  throw new Error("expected SelfServiceClaimError to be thrown");
}

describe("claimSelfServicePlan", () => {
  it("claims a plan that is enabled+published+selfServiceEligible", async () => {
    const planRepository = mockPlanRepository();
    planRepository.findById.mockResolvedValue(planWith({}));
    const subscriptionRepository = mockSubscriptionRepository();
    subscriptionRepository.grantFromPlan.mockResolvedValue(sampleSubscription);

    const result = await claimSelfServicePlan(
      { organizationId: ORG_ID, planId: PLAN_ID },
      {
        authz: authzFor("member"),
        planRepository: planRepository as unknown as PlanRepository,
        subscriptionRepository:
          subscriptionRepository as unknown as SubscriptionRepository,
      },
    );

    expect(result).toBe(sampleSubscription);
    expect(subscriptionRepository.grantFromPlan).toHaveBeenCalledWith(
      ORG_ID,
      PLAN_ID,
      USER_ID,
    );
  });

  // S-2 REQUIRED PROOF: each single self-service flag being false blocks the
  // claim with `plan_not_self_service` and NEVER grants.
  const gateCases: readonly {
    readonly label: string;
    readonly plan: Partial<Plan>;
  }[] = [
    { label: "enabled=false", plan: { enabled: false } },
    { label: "published=false", plan: { published: false } },
    { label: "selfServiceEligible=false", plan: { selfServiceEligible: false } },
  ];

  for (const { label, plan } of gateCases) {
    it(`refuses a plan with ${label} (plan_not_self_service, never grants)`, async () => {
      const planRepository = mockPlanRepository();
      planRepository.findById.mockResolvedValue(planWith(plan));
      const subscriptionRepository = mockSubscriptionRepository();

      expect(
        await claimReasonOf(() =>
          claimSelfServicePlan(
            { organizationId: ORG_ID, planId: PLAN_ID },
            {
              authz: authzFor("member"),
              planRepository: planRepository as unknown as PlanRepository,
              subscriptionRepository:
                subscriptionRepository as unknown as SubscriptionRepository,
            },
          ),
        ),
      ).toBe("plan_not_self_service");
      expect(subscriptionRepository.grantFromPlan).not.toHaveBeenCalled();
    });
  }

  it("refuses an unknown plan id (plan_not_available, never grants)", async () => {
    const planRepository = mockPlanRepository();
    planRepository.findById.mockResolvedValue(undefined);
    const subscriptionRepository = mockSubscriptionRepository();

    expect(
      await claimReasonOf(() =>
        claimSelfServicePlan(
          { organizationId: ORG_ID, planId: PLAN_ID },
          {
            authz: authzFor("member"),
            planRepository: planRepository as unknown as PlanRepository,
            subscriptionRepository:
              subscriptionRepository as unknown as SubscriptionRepository,
          },
        ),
      ),
    ).toBe("plan_not_available");
    expect(subscriptionRepository.grantFromPlan).not.toHaveBeenCalled();
  });

  it("rejects a malformed plan id before the repository (plan_not_available)", async () => {
    const planRepository = mockPlanRepository();
    const subscriptionRepository = mockSubscriptionRepository();

    expect(
      await claimReasonOf(() =>
        claimSelfServicePlan(
          { organizationId: ORG_ID, planId: "not-a-uuid" },
          {
            authz: authzFor("member"),
            planRepository: planRepository as unknown as PlanRepository,
            subscriptionRepository:
              subscriptionRepository as unknown as SubscriptionRepository,
          },
        ),
      ),
    ).toBe("plan_not_available");
    expect(planRepository.findById).not.toHaveBeenCalled();
    expect(subscriptionRepository.grantFromPlan).not.toHaveBeenCalled();
  });

  it("rejects a non-member BEFORE the plan lookup or grant", async () => {
    const planRepository = mockPlanRepository();
    const subscriptionRepository = mockSubscriptionRepository();

    // An authenticated non-member fails the membership gate in
    // `requireOrganization` and never reaches the plan lookup / grant.
    expect(
      await reasonOf(() =>
        claimSelfServicePlan(
          { organizationId: ORG_ID, planId: PLAN_ID },
          {
            authz: authzFor("user"),
            planRepository: planRepository as unknown as PlanRepository,
            subscriptionRepository:
              subscriptionRepository as unknown as SubscriptionRepository,
          },
        ),
      ),
    ).toBe("not_a_member");
    expect(planRepository.findById).not.toHaveBeenCalled();
    expect(subscriptionRepository.grantFromPlan).not.toHaveBeenCalled();
  });

  it("propagates a one-time plan_already_claimed conflict from the repo", async () => {
    const planRepository = mockPlanRepository();
    planRepository.findById.mockResolvedValue(planWith({}));
    const subscriptionRepository = mockSubscriptionRepository();
    subscriptionRepository.grantFromPlan.mockRejectedValue(
      Object.assign(new Error("plan_already_claimed"), {
        name: "DomainConflictError",
        code: "plan_already_claimed",
      }),
    );

    await expect(
      claimSelfServicePlan(
        { organizationId: ORG_ID, planId: PLAN_ID },
        {
          authz: authzFor("member"),
          planRepository: planRepository as unknown as PlanRepository,
          subscriptionRepository:
            subscriptionRepository as unknown as SubscriptionRepository,
        },
      ),
    ).rejects.toMatchObject({ code: "plan_already_claimed" });
  });
});

describe("adminGrantPlan", () => {
  it("blocks a non-admin and never grants", async () => {
    const subscriptionRepository = mockSubscriptionRepository();
    expect(
      await reasonOf(() =>
        adminGrantPlan(
          { organizationId: ORG_ID, planId: PLAN_ID },
          {
            authz: authzFor("user"),
            subscriptionRepository:
              subscriptionRepository as unknown as SubscriptionRepository,
          },
        ),
      ),
    ).toBe("forbidden");
    expect(subscriptionRepository.grantFromPlan).not.toHaveBeenCalled();
  });

  it("grants as the acting admin — INCLUDING an unpublished/non-self-service plan", async () => {
    // The admin grant deliberately bypasses `published`/`selfServiceEligible`:
    // we prove that by wiring a plan that is enabled + admin-grantable but NOT
    // published / self-service, and asserting the grant still forwards.
    const planRepository = mockPlanRepository();
    planRepository.findById.mockResolvedValue(
      planWith({
        published: false,
        selfServiceEligible: false,
        adminGrantable: true,
      }),
    );
    const subscriptionRepository = mockSubscriptionRepository();
    subscriptionRepository.grantFromPlan.mockResolvedValue({
      ...sampleSubscription,
      planKey: "admin-only",
    });

    const result = await adminGrantPlan(
      { organizationId: ORG_ID, planId: PLAN_ID },
      {
        authz: authzFor("admin"),
        planRepository: planRepository as unknown as PlanRepository,
        subscriptionRepository:
          subscriptionRepository as unknown as SubscriptionRepository,
      },
    );

    expect(result.planKey).toBe("admin-only");
    expect(subscriptionRepository.grantFromPlan).toHaveBeenCalledWith(
      ORG_ID,
      PLAN_ID,
      ADMIN_ID,
    );
  });

  it("refuses a plan with adminGrantable=false (plan_not_admin_grantable, never grants)", async () => {
    const planRepository = mockPlanRepository();
    planRepository.findById.mockResolvedValue(
      planWith({ adminGrantable: false }),
    );
    const subscriptionRepository = mockSubscriptionRepository();

    let caught: unknown;
    try {
      await adminGrantPlan(
        { organizationId: ORG_ID, planId: PLAN_ID },
        {
          authz: authzFor("admin"),
          planRepository: planRepository as unknown as PlanRepository,
          subscriptionRepository:
            subscriptionRepository as unknown as SubscriptionRepository,
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AdminGrantError);
    expect((caught as AdminGrantError).reason).toBe("plan_not_admin_grantable");
    expect(subscriptionRepository.grantFromPlan).not.toHaveBeenCalled();
  });

  it("refuses a disabled plan even if admin-grantable (plan_not_admin_grantable, never grants)", async () => {
    const planRepository = mockPlanRepository();
    planRepository.findById.mockResolvedValue(
      planWith({ enabled: false, adminGrantable: true }),
    );
    const subscriptionRepository = mockSubscriptionRepository();

    let caught: unknown;
    try {
      await adminGrantPlan(
        { organizationId: ORG_ID, planId: PLAN_ID },
        {
          authz: authzFor("admin"),
          planRepository: planRepository as unknown as PlanRepository,
          subscriptionRepository:
            subscriptionRepository as unknown as SubscriptionRepository,
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AdminGrantError);
    expect((caught as AdminGrantError).reason).toBe("plan_not_admin_grantable");
    expect(subscriptionRepository.grantFromPlan).not.toHaveBeenCalled();
  });

  it("refuses an unknown plan id (plan_not_available, never grants)", async () => {
    const planRepository = mockPlanRepository();
    planRepository.findById.mockResolvedValue(undefined);
    const subscriptionRepository = mockSubscriptionRepository();

    let caught: unknown;
    try {
      await adminGrantPlan(
        { organizationId: ORG_ID, planId: PLAN_ID },
        {
          authz: authzFor("admin"),
          planRepository: planRepository as unknown as PlanRepository,
          subscriptionRepository:
            subscriptionRepository as unknown as SubscriptionRepository,
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AdminGrantError);
    expect((caught as AdminGrantError).reason).toBe("plan_not_available");
    expect(subscriptionRepository.grantFromPlan).not.toHaveBeenCalled();
  });

  it("rejects a malformed org/plan id after admin gate, before granting", async () => {
    const subscriptionRepository = mockSubscriptionRepository();
    let caught: unknown;
    try {
      await adminGrantPlan(
        { organizationId: "not-a-uuid", planId: PLAN_ID },
        {
          authz: authzFor("admin"),
          subscriptionRepository:
            subscriptionRepository as unknown as SubscriptionRepository,
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SubscriptionInputError);
    expect((caught as SubscriptionInputError).reason).toBe("invalid_grant_input");
    expect(subscriptionRepository.grantFromPlan).not.toHaveBeenCalled();
  });
});

describe("adminSetSubscriptionStatus", () => {
  it("blocks a non-admin before validating the id", async () => {
    const subscriptionRepository = mockSubscriptionRepository();
    expect(
      await reasonOf(() =>
        adminSetSubscriptionStatus(
          { subscriptionId: "not-a-uuid", status: "suspended" },
          {
            authz: authzFor("user"),
            subscriptionRepository:
              subscriptionRepository as unknown as SubscriptionRepository,
          },
        ),
      ),
    ).toBe("forbidden");
    expect(subscriptionRepository.setStatus).not.toHaveBeenCalled();
  });

  it("rejects a malformed subscription id before the repository", async () => {
    const subscriptionRepository = mockSubscriptionRepository();
    await expect(
      adminSetSubscriptionStatus(
        { subscriptionId: "not-a-uuid", status: "suspended" },
        {
          authz: authzFor("admin"),
          subscriptionRepository:
            subscriptionRepository as unknown as SubscriptionRepository,
        },
      ),
    ).rejects.toBeInstanceOf(SubscriptionInputError);
    expect(subscriptionRepository.setStatus).not.toHaveBeenCalled();
  });

  it("forwards a valid status change to the repository", async () => {
    const subscriptionRepository = mockSubscriptionRepository();
    subscriptionRepository.setStatus.mockResolvedValue({
      ...sampleSubscription,
      status: "suspended",
    });

    const result = await adminSetSubscriptionStatus(
      { subscriptionId: SUB_ID, status: "suspended" },
      {
        authz: authzFor("admin"),
        subscriptionRepository:
          subscriptionRepository as unknown as SubscriptionRepository,
      },
    );

    expect(result?.status).toBe("suspended");
    expect(subscriptionRepository.setStatus).toHaveBeenCalledWith(
      SUB_ID,
      "suspended",
    );
  });
});

describe("listSelfServicePlans", () => {
  it("lists self-service plans for a signed-in user", async () => {
    const planRepository = mockPlanRepository();
    const plans = [planWith({})];
    planRepository.listSelfServicePublished.mockResolvedValue(plans);

    const result = await listSelfServicePlans({
      authz: authzFor("user"),
      planRepository: planRepository as unknown as PlanRepository,
    });

    expect(result).toEqual(plans);
    expect(planRepository.listSelfServicePublished).toHaveBeenCalledTimes(1);
  });

  it("rejects an unauthenticated caller", async () => {
    const planRepository = mockPlanRepository();
    expect(
      await reasonOf(() =>
        listSelfServicePlans({
          authz: authzFor("none"),
          planRepository: planRepository as unknown as PlanRepository,
        }),
      ),
    ).toBe("unauthenticated");
    expect(planRepository.listSelfServicePublished).not.toHaveBeenCalled();
  });
});

describe("listOrganizationSubscriptions", () => {
  it("lists the caller's org subscriptions", async () => {
    const subscriptionRepository = mockSubscriptionRepository();
    subscriptionRepository.listForOrganization.mockResolvedValue([
      sampleSubscription,
    ]);

    const result = await listOrganizationSubscriptions(ORG_ID, {
      authz: authzFor("member"),
      subscriptionRepository:
        subscriptionRepository as unknown as SubscriptionRepository,
    });

    expect(result).toEqual([sampleSubscription]);
    expect(subscriptionRepository.listForOrganization).toHaveBeenCalledWith(
      ORG_ID,
    );
  });

  it("rejects a non-member and never reads subscriptions", async () => {
    const subscriptionRepository = mockSubscriptionRepository();
    expect(
      await reasonOf(() =>
        listOrganizationSubscriptions(ORG_ID, {
          authz: authzFor("user"),
          subscriptionRepository:
            subscriptionRepository as unknown as SubscriptionRepository,
        }),
      ),
    ).toBe("not_a_member");
    expect(subscriptionRepository.listForOrganization).not.toHaveBeenCalled();
  });
});

describe("resolveCallerPersonalOrganizationId", () => {
  it("resolves the signed-in caller's personal org id", async () => {
    const resolvePersonalOrganizationId = vi.fn(() => Promise.resolve(ORG_ID));
    const result = await resolveCallerPersonalOrganizationId({
      authz: authzFor("member"),
      resolvePersonalOrganizationId,
    });
    expect(result).toBe(ORG_ID);
    expect(resolvePersonalOrganizationId).toHaveBeenCalledWith(USER_ID);
  });

  it("fails closed when the caller has no personal org", async () => {
    const resolvePersonalOrganizationId = vi.fn(() => Promise.resolve(null));
    expect(
      await reasonOf(() =>
        resolveCallerPersonalOrganizationId({
          authz: authzFor("member"),
          resolvePersonalOrganizationId,
        }),
      ),
    ).toBe("organization_not_found");
  });

  it("rejects an unauthenticated caller before resolving an org", async () => {
    const resolvePersonalOrganizationId = vi.fn(() => Promise.resolve(ORG_ID));
    expect(
      await reasonOf(() =>
        resolveCallerPersonalOrganizationId({
          authz: authzFor("none"),
          resolvePersonalOrganizationId,
        }),
      ),
    ).toBe("unauthenticated");
    expect(resolvePersonalOrganizationId).not.toHaveBeenCalled();
  });
});

describe("claimSelfServicePlanForCaller", () => {
  it("resolves the caller's org then applies the self-service gate + grants", async () => {
    const planRepository = mockPlanRepository();
    planRepository.findById.mockResolvedValue(planWith({}));
    const subscriptionRepository = mockSubscriptionRepository();
    subscriptionRepository.grantFromPlan.mockResolvedValue(sampleSubscription);
    const resolvePersonalOrganizationId = vi.fn(() => Promise.resolve(ORG_ID));

    const result = await claimSelfServicePlanForCaller(PLAN_ID, {
      authz: authzFor("member"),
      planRepository: planRepository as unknown as PlanRepository,
      subscriptionRepository:
        subscriptionRepository as unknown as SubscriptionRepository,
      resolvePersonalOrganizationId,
    });

    expect(result).toEqual(sampleSubscription);
    expect(resolvePersonalOrganizationId).toHaveBeenCalledWith(USER_ID);
    expect(subscriptionRepository.grantFromPlan).toHaveBeenCalledWith(
      ORG_ID,
      PLAN_ID,
      USER_ID,
    );
  });

  it("still enforces the gate for the caller path (non-self-service never grants)", async () => {
    const planRepository = mockPlanRepository();
    planRepository.findById.mockResolvedValue(planWith({ published: false }));
    const subscriptionRepository = mockSubscriptionRepository();
    const resolvePersonalOrganizationId = vi.fn(() => Promise.resolve(ORG_ID));

    expect(
      await claimReasonOf(() =>
        claimSelfServicePlanForCaller(PLAN_ID, {
          authz: authzFor("member"),
          planRepository: planRepository as unknown as PlanRepository,
          subscriptionRepository:
            subscriptionRepository as unknown as SubscriptionRepository,
          resolvePersonalOrganizationId,
        }),
      ),
    ).toBe("plan_not_self_service");
    expect(subscriptionRepository.grantFromPlan).not.toHaveBeenCalled();
  });
});

describe("listCallerSubscriptions", () => {
  it("resolves the caller's org then lists its subscriptions", async () => {
    const subscriptionRepository = mockSubscriptionRepository();
    subscriptionRepository.listForOrganization.mockResolvedValue([
      sampleSubscription,
    ]);
    const resolvePersonalOrganizationId = vi.fn(() => Promise.resolve(ORG_ID));

    const result = await listCallerSubscriptions({
      authz: authzFor("member"),
      subscriptionRepository:
        subscriptionRepository as unknown as SubscriptionRepository,
      resolvePersonalOrganizationId,
    });

    expect(result).toEqual([sampleSubscription]);
    expect(subscriptionRepository.listForOrganization).toHaveBeenCalledWith(
      ORG_ID,
    );
  });
});
