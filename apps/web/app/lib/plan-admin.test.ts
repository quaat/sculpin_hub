import { describe, expect, it, vi } from "vitest";
import type { Plan, PlanInput, PlanRepository } from "@sculpin/domain";
import {
  PlanAdminInputError,
  attachPlanCatalogueEntry,
  createPlan,
  detachPlanCatalogueEntry,
  getPlanForAdmin,
  listPlansForAdmin,
  setPlanEnabled,
  setPlanPublished,
  updatePlan,
} from "./plan-admin";
import { AuthzError, type AuthzDeps, type Session } from "./session";

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const PLAN_ID = "22222222-2222-4222-8222-222222222222";
const ENTRY_ID = "33333333-3333-4333-8333-333333333333";

function authzFor(role: "user" | "admin" | "none"): Partial<AuthzDeps> {
  const emptyOrg = () =>
    Promise.resolve({ organization: null, membership: null });
  if (role === "none") {
    return {
      loadSession: () => Promise.resolve(null),
      store: {
        loadUserById: () => Promise.resolve(null),
        loadOrgWithMembership: emptyOrg,
      },
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

function mockRepository() {
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

const samplePlan: Plan = {
  id: PLAN_ID,
  key: "free-trial",
  name: "Free Trial",
  kind: "free_trial",
  enabled: true,
  published: false,
  selfServiceEligible: false,
  adminGrantable: true,
  requestQuota: 100,
  oneTimePerOrganization: true,
  version: 1,
  catalogueEntryIds: [],
};

const planInput: PlanInput = {
  key: "free-trial",
  name: "Free Trial",
  kind: "free_trial",
  requestQuota: 100,
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

describe("plan-admin requireAdmin gating", () => {
  const mutators: readonly {
    readonly label: string;
    readonly call: (
      repository: PlanRepository,
      authz: Partial<AuthzDeps>,
    ) => Promise<unknown>;
    readonly probe: (repository: ReturnType<typeof mockRepository>) => unknown;
  }[] = [
    {
      label: "createPlan",
      call: (repository, authz) =>
        createPlan(planInput, { authz, repository }),
      probe: (r) => r.create,
    },
    {
      label: "updatePlan",
      call: (repository, authz) =>
        updatePlan(PLAN_ID, { name: "New" }, { authz, repository }),
      probe: (r) => r.update,
    },
    {
      label: "setPlanEnabled",
      call: (repository, authz) =>
        setPlanEnabled(PLAN_ID, false, { authz, repository }),
      probe: (r) => r.setEnabled,
    },
    {
      label: "setPlanPublished",
      call: (repository, authz) =>
        setPlanPublished(PLAN_ID, true, { authz, repository }),
      probe: (r) => r.setPublished,
    },
    {
      label: "attachPlanCatalogueEntry",
      call: (repository, authz) =>
        attachPlanCatalogueEntry(PLAN_ID, ENTRY_ID, { authz, repository }),
      probe: (r) => r.attachCatalogueEntry,
    },
    {
      label: "detachPlanCatalogueEntry",
      call: (repository, authz) =>
        detachPlanCatalogueEntry(PLAN_ID, ENTRY_ID, { authz, repository }),
      probe: (r) => r.detachCatalogueEntry,
    },
    {
      label: "listPlansForAdmin",
      call: (repository, authz) => listPlansForAdmin({ authz, repository }),
      probe: (r) => r.listAll,
    },
    {
      label: "getPlanForAdmin",
      call: (repository, authz) =>
        getPlanForAdmin(PLAN_ID, { authz, repository }),
      probe: (r) => r.findById,
    },
  ];

  for (const { label, call, probe } of mutators) {
    it(`blocks a non-admin for ${label}`, async () => {
      const repository = mockRepository();
      expect(
        await reasonOf(() =>
          call(
            repository as unknown as PlanRepository,
            authzFor("user"),
          ),
        ),
      ).toBe("forbidden");
      expect(probe(repository)).not.toHaveBeenCalled();
    });
  }
});

describe("plan-admin happy-path forwarding", () => {
  it("createPlan forwards to the repo with the acting admin id", async () => {
    const repository = mockRepository();
    repository.create.mockResolvedValue(samplePlan);
    const result = await createPlan(planInput, {
      authz: authzFor("admin"),
      repository: repository as unknown as PlanRepository,
    });
    expect(result).toBe(samplePlan);
    expect(repository.create).toHaveBeenCalledWith(planInput, ADMIN_ID);
  });

  it("updatePlan forwards patch + admin id", async () => {
    const repository = mockRepository();
    repository.update.mockResolvedValue(samplePlan);
    await updatePlan(PLAN_ID, { name: "New" }, {
      authz: authzFor("admin"),
      repository: repository as unknown as PlanRepository,
    });
    expect(repository.update).toHaveBeenCalledWith(
      PLAN_ID,
      { name: "New" },
      ADMIN_ID,
    );
  });

  it("setPlanEnabled / setPlanPublished forward flags", async () => {
    const repository = mockRepository();
    repository.setEnabled.mockResolvedValue(samplePlan);
    repository.setPublished.mockResolvedValue(samplePlan);
    await setPlanEnabled(PLAN_ID, false, {
      authz: authzFor("admin"),
      repository: repository as unknown as PlanRepository,
    });
    await setPlanPublished(PLAN_ID, true, {
      authz: authzFor("admin"),
      repository: repository as unknown as PlanRepository,
    });
    expect(repository.setEnabled).toHaveBeenCalledWith(PLAN_ID, false, ADMIN_ID);
    expect(repository.setPublished).toHaveBeenCalledWith(PLAN_ID, true, ADMIN_ID);
  });

  it("attach / detach forward plan + entry ids", async () => {
    const repository = mockRepository();
    repository.attachCatalogueEntry.mockResolvedValue(samplePlan);
    repository.detachCatalogueEntry.mockResolvedValue(samplePlan);
    await attachPlanCatalogueEntry(PLAN_ID, ENTRY_ID, {
      authz: authzFor("admin"),
      repository: repository as unknown as PlanRepository,
    });
    await detachPlanCatalogueEntry(PLAN_ID, ENTRY_ID, {
      authz: authzFor("admin"),
      repository: repository as unknown as PlanRepository,
    });
    expect(repository.attachCatalogueEntry).toHaveBeenCalledWith(PLAN_ID, ENTRY_ID);
    expect(repository.detachCatalogueEntry).toHaveBeenCalledWith(PLAN_ID, ENTRY_ID);
  });

  it("listPlansForAdmin / getPlanForAdmin forward to the repo", async () => {
    const repository = mockRepository();
    repository.listAll.mockResolvedValue([samplePlan]);
    repository.findById.mockResolvedValue(samplePlan);
    expect(
      await listPlansForAdmin({
        authz: authzFor("admin"),
        repository: repository as unknown as PlanRepository,
      }),
    ).toEqual([samplePlan]);
    expect(
      await getPlanForAdmin(PLAN_ID, {
        authz: authzFor("admin"),
        repository: repository as unknown as PlanRepository,
      }),
    ).toBe(samplePlan);
    expect(repository.findById).toHaveBeenCalledWith(PLAN_ID);
  });
});

describe("plan-admin uuid validation", () => {
  const idMutators: readonly {
    readonly label: string;
    readonly call: (
      repository: PlanRepository,
      authz: Partial<AuthzDeps>,
    ) => Promise<unknown>;
    readonly probe: (repository: ReturnType<typeof mockRepository>) => unknown;
  }[] = [
    {
      label: "updatePlan",
      call: (repository, authz) =>
        updatePlan("not-a-uuid", { name: "x" }, { authz, repository }),
      probe: (r) => r.update,
    },
    {
      label: "setPlanEnabled",
      call: (repository, authz) =>
        setPlanEnabled("not-a-uuid", true, { authz, repository }),
      probe: (r) => r.setEnabled,
    },
    {
      label: "setPlanPublished",
      call: (repository, authz) =>
        setPlanPublished("not-a-uuid", true, { authz, repository }),
      probe: (r) => r.setPublished,
    },
    {
      label: "getPlanForAdmin",
      call: (repository, authz) =>
        getPlanForAdmin("not-a-uuid", { authz, repository }),
      probe: (r) => r.findById,
    },
    {
      label: "attachPlanCatalogueEntry (bad entry id)",
      call: (repository, authz) =>
        attachPlanCatalogueEntry(PLAN_ID, "not-a-uuid", { authz, repository }),
      probe: (r) => r.attachCatalogueEntry,
    },
  ];

  for (const { label, call, probe } of idMutators) {
    it(`rejects a malformed id for ${label} (admin, bad input)`, async () => {
      const repository = mockRepository();
      await expect(
        call(repository as unknown as PlanRepository, authzFor("admin")),
      ).rejects.toBeInstanceOf(PlanAdminInputError);
      expect(probe(repository)).not.toHaveBeenCalled();
    });
  }
});
