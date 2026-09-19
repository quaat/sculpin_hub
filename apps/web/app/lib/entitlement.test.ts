import { describe, expect, it, vi } from "vitest";
import type { Subscription, SubscriptionRepository } from "@sculpin/domain";
import {
  getOrganizationEntitlement,
  requireEntitledOrganization,
} from "./entitlement";
import {
  AuthzError,
  type AuthzDeps,
  type CanonicalMembership,
  type CanonicalOrganization,
  type Session,
} from "./session";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-09-19T00:00:00.000Z");

interface AuthzShape {
  readonly authenticated?: boolean;
  readonly userActive?: boolean;
  readonly organization?: CanonicalOrganization | null;
  readonly membership?: CanonicalMembership | null;
}

function authzFor(shape: AuthzShape = {}): Partial<AuthzDeps> {
  const {
    authenticated = true,
    userActive = true,
    organization = {
      id: ORG_ID,
      slug: "p-org",
      type: "personal",
      status: "active",
    },
    membership = { role: "owner", status: "active" },
  } = shape;
  return {
    loadSession: () =>
      authenticated
        ? Promise.resolve({ user: { id: USER_ID } } as unknown as Session)
        : Promise.resolve(null),
    store: {
      loadUserById: () =>
        Promise.resolve({
          id: USER_ID,
          role: "user" as const,
          status: userActive ? ("active" as const) : ("deactivated" as const),
          normalizedEmail: "user@example.com",
          displayName: "User",
        }),
      loadOrgWithMembership: () => Promise.resolve({ organization, membership }),
    },
  };
}

function sub(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    organizationId: ORG_ID,
    plan: "trial",
    status: "active",
    quotaLimit: 200,
    quotaUsed: 0,
    startsAt: new Date("2026-09-01T00:00:00.000Z"),
    version: 1,
    ...overrides,
  };
}

function repoWith(subscriptions: readonly Subscription[]) {
  return {
    listForOrganization: vi.fn().mockResolvedValue(subscriptions),
    reserveQuota: vi.fn(),
    setStatus: vi.fn(),
  };
}

async function reasonOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AuthzError);
    return (error as AuthzError).reason;
  }
  throw new Error("expected AuthzError to be thrown");
}

describe("getOrganizationEntitlement", () => {
  it("resolves the entitlement for an active member", async () => {
    const repository = repoWith([sub({ quotaUsed: 50 })]);
    const ctx = await getOrganizationEntitlement(ORG_ID, {
      authz: authzFor(),
      repository: repository as unknown as SubscriptionRepository,
      now: () => NOW,
    });
    expect(ctx.entitlement).toEqual({
      organizationId: ORG_ID,
      active: true,
      plans: ["trial"],
      remainingQuota: 150,
    });
    expect(repository.listForOrganization).toHaveBeenCalledWith(ORG_ID);
  });

  it("returns an inactive entitlement without throwing when quota is spent", async () => {
    const repository = repoWith([sub({ quotaUsed: 200 })]);
    const ctx = await getOrganizationEntitlement(ORG_ID, {
      authz: authzFor(),
      repository: repository as unknown as SubscriptionRepository,
      now: () => NOW,
    });
    expect(ctx.entitlement.active).toBe(true);
    expect(ctx.entitlement.remainingQuota).toBe(0);
  });

  it("rejects a non-member before reading subscriptions", async () => {
    const repository = repoWith([sub()]);
    expect(
      await reasonOf(() =>
        getOrganizationEntitlement(ORG_ID, {
          authz: authzFor({ membership: null }),
          repository: repository as unknown as SubscriptionRepository,
          now: () => NOW,
        }),
      ),
    ).toBe("not_a_member");
    expect(repository.listForOrganization).not.toHaveBeenCalled();
  });
});

describe("requireEntitledOrganization", () => {
  it("passes for an active, in-quota tenant", async () => {
    const repository = repoWith([sub({ quotaUsed: 199 })]);
    const ctx = await requireEntitledOrganization(ORG_ID, {
      authz: authzFor(),
      repository: repository as unknown as SubscriptionRepository,
      now: () => NOW,
    });
    expect(ctx.entitlement.remainingQuota).toBe(1);
  });

  it("rejects when there is no active subscription", async () => {
    const repository = repoWith([sub({ status: "canceled" })]);
    expect(
      await reasonOf(() =>
        requireEntitledOrganization(ORG_ID, {
          authz: authzFor(),
          repository: repository as unknown as SubscriptionRepository,
          now: () => NOW,
        }),
      ),
    ).toBe("no_active_subscription");
  });

  it("rejects when quota is exhausted", async () => {
    const repository = repoWith([sub({ quotaUsed: 200 })]);
    expect(
      await reasonOf(() =>
        requireEntitledOrganization(ORG_ID, {
          authz: authzFor(),
          repository: repository as unknown as SubscriptionRepository,
          now: () => NOW,
        }),
      ),
    ).toBe("quota_exhausted");
  });

  it("rejects an unauthenticated caller before any entitlement read", async () => {
    const repository = repoWith([sub()]);
    expect(
      await reasonOf(() =>
        requireEntitledOrganization(ORG_ID, {
          authz: authzFor({ authenticated: false }),
          repository: repository as unknown as SubscriptionRepository,
          now: () => NOW,
        }),
      ),
    ).toBe("unauthenticated");
    expect(repository.listForOrganization).not.toHaveBeenCalled();
  });
});
