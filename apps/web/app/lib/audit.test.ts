import { describe, expect, it, vi } from "vitest";
import type {
  AuditLogEntryView,
  UsageSummaryView,
} from "@sculpin/domain";
import { getUsageSummary, listRecentAuditEvents } from "./audit";
import { AuthzError, type AuthzDeps, type Session } from "./session";

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";

function authzFor(role: "user" | "admin" | "none"): Partial<AuthzDeps> {
  const emptyOrg = () =>
    Promise.resolve({ organization: null, membership: null });
  if (role === "none") {
    return {
      loadSession: () => Promise.resolve(null),
      store: { loadUserById: () => Promise.resolve(null), loadOrgWithMembership: emptyOrg },
    };
  }
  return {
    loadSession: () =>
      Promise.resolve({ user: { id: ADMIN_ID } } as unknown as Session),
    store: {
      loadUserById: () =>
        Promise.resolve({
          id: ADMIN_ID,
          role,
          status: "active" as const,
          normalizedEmail: "admin@example.com",
          displayName: "Admin",
        }),
      loadOrgWithMembership: emptyOrg,
    },
  };
}

const sampleEvent: AuditLogEntryView = {
  id: "22222222-2222-4222-8222-222222222222",
  occurredAt: "2026-09-20T00:00:00.000Z",
  action: "catalogue_entry.created",
  targetType: "catalogue_entry",
  targetId: "33333333-3333-4333-8333-333333333333",
  actorUserId: ADMIN_ID,
  actorEmail: "admin@example.com",
  actorDisplayName: "Admin",
  systemActor: null,
  organizationId: null,
  organizationSlug: null,
  beforeSummary: null,
  afterSummary: { publicAlias: "sculpin-fast", status: "draft" },
};

const sampleUsage: UsageSummaryView = {
  totalRequestCount: 3,
  totalQuotaCost: 7,
  topOrganizations: [
    {
      organizationId: "44444444-4444-4444-8444-444444444444",
      organizationSlug: "acme",
      requestCount: 3,
      totalQuotaCost: 7,
    },
  ],
};

function fakeAuditRepository() {
  return { listRecent: vi.fn().mockResolvedValue([sampleEvent]) };
}

function fakeUsageRepository() {
  return { summarize: vi.fn().mockResolvedValue(sampleUsage) };
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

describe("listRecentAuditEvents", () => {
  it("lists recent events for an admin, passing the requested limit through", async () => {
    const auditRepository = fakeAuditRepository();
    const result = await listRecentAuditEvents(25, {
      authz: authzFor("admin"),
      auditRepository,
    });
    expect(result).toEqual([sampleEvent]);
    expect(auditRepository.listRecent).toHaveBeenCalledWith(25);
  });

  it("defaults the limit to 50 when not provided", async () => {
    const auditRepository = fakeAuditRepository();
    await listRecentAuditEvents(undefined, {
      authz: authzFor("admin"),
      auditRepository,
    });
    expect(auditRepository.listRecent).toHaveBeenCalledWith(50);
  });

  it("rejects a non-admin and never touches the repository", async () => {
    const auditRepository = fakeAuditRepository();
    expect(
      await reasonOf(() =>
        listRecentAuditEvents(10, {
          authz: authzFor("user"),
          auditRepository,
        }),
      ),
    ).toBe("forbidden");
    expect(auditRepository.listRecent).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated caller", async () => {
    const auditRepository = fakeAuditRepository();
    expect(
      await reasonOf(() =>
        listRecentAuditEvents(10, {
          authz: authzFor("none"),
          auditRepository,
        }),
      ),
    ).toBe("unauthenticated");
    expect(auditRepository.listRecent).not.toHaveBeenCalled();
  });
});

describe("getUsageSummary", () => {
  it("returns the aggregate summary for an admin", async () => {
    const usageRepository = fakeUsageRepository();
    const result = await getUsageSummary({
      authz: authzFor("admin"),
      usageRepository,
    });
    expect(result).toEqual(sampleUsage);
    expect(usageRepository.summarize).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-admin and never touches the repository", async () => {
    const usageRepository = fakeUsageRepository();
    expect(
      await reasonOf(() =>
        getUsageSummary({
          authz: authzFor("user"),
          usageRepository,
        }),
      ),
    ).toBe("forbidden");
    expect(usageRepository.summarize).not.toHaveBeenCalled();
  });
});
