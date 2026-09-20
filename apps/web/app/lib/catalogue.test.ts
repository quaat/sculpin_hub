import { describe, expect, it, vi } from "vitest";
import type {
  CatalogueEntry,
  CatalogueRepository,
  DiscoveredAgent,
} from "@sculpin/domain";
import {
  CatalogueInputError,
  UndiscoverableAgentError,
  createCatalogueEntry,
  createCatalogueEntryFromDiscovered,
  detectCatalogueDrift,
  listCatalogueForAdmin,
  listPublicModels,
  publishCatalogueEntry,
  unpublishCatalogueEntry,
} from "./catalogue";
import { AuthzError, type AuthzDeps, type Session } from "./session";

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const ENTRY_ID = "22222222-2222-4222-8222-222222222222";

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

function mockRepository() {
  return {
    create: vi.fn(),
    publish: vi.fn(),
    unpublish: vi.fn(),
    listAll: vi.fn(),
    listPublished: vi.fn(),
    resolvePublishedAlias: vi.fn(),
  };
}

const sampleEntry: CatalogueEntry = {
  id: ENTRY_ID,
  publicAlias: "sculpin-fast",
  upstreamAgentId: "agent-42",
  displayName: "Sculpin Fast",
  status: "draft",
  version: 1,
};

const input = {
  publicAlias: "sculpin-fast",
  upstreamAgentId: "agent-42",
  displayName: "Sculpin Fast",
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

describe("createCatalogueEntry", () => {
  it("creates as the acting admin", async () => {
    const repository = mockRepository();
    repository.create.mockResolvedValue(sampleEntry);
    const result = await createCatalogueEntry(input, {
      authz: authzFor("admin"),
      repository: repository as unknown as CatalogueRepository,
    });
    expect(result).toBe(sampleEntry);
    expect(repository.create).toHaveBeenCalledWith(input, ADMIN_ID);
  });

  it("rejects a non-admin and never touches the repository", async () => {
    const repository = mockRepository();
    expect(
      await reasonOf(() =>
        createCatalogueEntry(input, {
          authz: authzFor("user"),
          repository: repository as unknown as CatalogueRepository,
        }),
      ),
    ).toBe("forbidden");
    expect(repository.create).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated caller", async () => {
    const repository = mockRepository();
    expect(
      await reasonOf(() =>
        createCatalogueEntry(input, {
          authz: authzFor("none"),
          repository: repository as unknown as CatalogueRepository,
        }),
      ),
    ).toBe("unauthenticated");
    expect(repository.create).not.toHaveBeenCalled();
  });
});

describe("publishCatalogueEntry / unpublishCatalogueEntry", () => {
  it("publishes as the acting admin", async () => {
    const repository = mockRepository();
    repository.publish.mockResolvedValue({ ...sampleEntry, status: "published" });
    await publishCatalogueEntry(ENTRY_ID, {
      authz: authzFor("admin"),
      repository: repository as unknown as CatalogueRepository,
    });
    expect(repository.publish).toHaveBeenCalledWith(ENTRY_ID, ADMIN_ID);
  });

  it("unpublishes as the acting admin", async () => {
    const repository = mockRepository();
    repository.unpublish.mockResolvedValue({ ...sampleEntry, status: "disabled" });
    await unpublishCatalogueEntry(ENTRY_ID, {
      authz: authzFor("admin"),
      repository: repository as unknown as CatalogueRepository,
    });
    expect(repository.unpublish).toHaveBeenCalledWith(ENTRY_ID, ADMIN_ID);
  });

  it("rejects a malformed entry id (admin, but bad input)", async () => {
    const repository = mockRepository();
    await expect(
      publishCatalogueEntry("not-a-uuid", {
        authz: authzFor("admin"),
        repository: repository as unknown as CatalogueRepository,
      }),
    ).rejects.toBeInstanceOf(CatalogueInputError);
    expect(repository.publish).not.toHaveBeenCalled();
  });

  it("checks admin BEFORE validating the id (fail closed on authz first)", async () => {
    const repository = mockRepository();
    expect(
      await reasonOf(() =>
        publishCatalogueEntry("not-a-uuid", {
          authz: authzFor("user"),
          repository: repository as unknown as CatalogueRepository,
        }),
      ),
    ).toBe("forbidden");
    expect(repository.publish).not.toHaveBeenCalled();
  });
});

describe("listCatalogueForAdmin", () => {
  it("lists all entries for an admin", async () => {
    const repository = mockRepository();
    repository.listAll.mockResolvedValue([sampleEntry]);
    const result = await listCatalogueForAdmin({
      authz: authzFor("admin"),
      repository: repository as unknown as CatalogueRepository,
    });
    expect(result).toEqual([sampleEntry]);
  });

  it("rejects a non-admin", async () => {
    const repository = mockRepository();
    expect(
      await reasonOf(() =>
        listCatalogueForAdmin({
          authz: authzFor("user"),
          repository: repository as unknown as CatalogueRepository,
        }),
      ),
    ).toBe("forbidden");
    expect(repository.listAll).not.toHaveBeenCalled();
  });
});

describe("listPublicModels", () => {
  it("returns published models without requiring admin", async () => {
    const repository = mockRepository();
    repository.listPublished.mockResolvedValue([
      { id: "sculpin-fast", displayName: "Sculpin Fast" },
    ]);
    const result = await listPublicModels({
      repository: repository as unknown as CatalogueRepository,
    });
    expect(result).toEqual([{ id: "sculpin-fast", displayName: "Sculpin Fast" }]);
    expect(repository.listPublished).toHaveBeenCalledTimes(1);
  });
});

const AGENT_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GONE_UUID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function discovered(...ids: readonly string[]): readonly DiscoveredAgent[] {
  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return ids.map((id) => ({
    id,
    agentId: id,
    isUuid: uuidPattern.test(id),
    ownedBy: "exodus",
  }));
}

describe("createCatalogueEntryFromDiscovered", () => {
  const input = {
    publicAlias: "sculpin-fast",
    displayName: "Sculpin Fast",
    upstreamAgentId: AGENT_UUID,
  };

  it("creates when the agent is a discoverable stable id", async () => {
    const repository = mockRepository();
    repository.create.mockResolvedValue({
      ...sampleEntry,
      upstreamAgentId: AGENT_UUID,
    });
    const result = await createCatalogueEntryFromDiscovered(input, {
      authz: authzFor("admin"),
      repository: repository as unknown as CatalogueRepository,
      discoveredAgents: discovered("support", AGENT_UUID),
    });
    expect(result.upstreamAgentId).toBe(AGENT_UUID);
    expect(repository.create).toHaveBeenCalledWith(
      {
        publicAlias: "sculpin-fast",
        upstreamAgentId: AGENT_UUID,
        displayName: "Sculpin Fast",
      },
      ADMIN_ID,
    );
  });

  it("fails closed for an unknown/disappeared agent id (never creates)", async () => {
    const repository = mockRepository();
    await expect(
      createCatalogueEntryFromDiscovered(input, {
        authz: authzFor("admin"),
        repository: repository as unknown as CatalogueRepository,
        discoveredAgents: discovered("support"),
      }),
    ).rejects.toBeInstanceOf(UndiscoverableAgentError);
    expect(repository.create).not.toHaveBeenCalled();
  });

  it("fails closed when only a SLUG-form id is discoverable (not stable)", async () => {
    const repository = mockRepository();
    await expect(
      createCatalogueEntryFromDiscovered(
        { ...input, upstreamAgentId: "support" },
        {
          authz: authzFor("admin"),
          repository: repository as unknown as CatalogueRepository,
          discoveredAgents: discovered("support", AGENT_UUID),
        },
      ),
    ).rejects.toBeInstanceOf(UndiscoverableAgentError);
    expect(repository.create).not.toHaveBeenCalled();
  });

  it("rejects a non-admin before discovery or creation", async () => {
    const repository = mockRepository();
    expect(
      await reasonOf(() =>
        createCatalogueEntryFromDiscovered(input, {
          authz: authzFor("user"),
          repository: repository as unknown as CatalogueRepository,
          discoveredAgents: discovered(AGENT_UUID),
        }),
      ),
    ).toBe("forbidden");
    expect(repository.create).not.toHaveBeenCalled();
  });
});

describe("detectCatalogueDrift", () => {
  it("flags a published entry whose upstream agent vanished", async () => {
    const repository = mockRepository();
    repository.listAll.mockResolvedValue([
      {
        ...sampleEntry,
        id: ENTRY_ID,
        publicAlias: "present",
        upstreamAgentId: AGENT_UUID,
        status: "published" as const,
      },
      {
        ...sampleEntry,
        id: "33333333-3333-4333-8333-333333333333",
        publicAlias: "gone",
        upstreamAgentId: GONE_UUID,
        status: "published" as const,
      },
    ]);
    const drift = await detectCatalogueDrift({
      authz: authzFor("admin"),
      repository: repository as unknown as CatalogueRepository,
      discoveredAgents: discovered(AGENT_UUID),
    });
    expect(drift).toEqual([
      {
        id: "33333333-3333-4333-8333-333333333333",
        publicAlias: "gone",
        upstreamAgentId: GONE_UUID,
        status: "published",
      },
    ]);
    // Does NOT auto-disable: unpublish is never called.
    expect(repository.unpublish).not.toHaveBeenCalled();
  });

  it("rejects a non-admin", async () => {
    const repository = mockRepository();
    expect(
      await reasonOf(() =>
        detectCatalogueDrift({
          authz: authzFor("user"),
          repository: repository as unknown as CatalogueRepository,
          discoveredAgents: discovered(AGENT_UUID),
        }),
      ),
    ).toBe("forbidden");
    expect(repository.listAll).not.toHaveBeenCalled();
  });
});

describe("resolvePublishedAlias contract (never substitutes another agent)", () => {
  it("returns ONLY the stored upstream agent id for a published alias", async () => {
    const repository = mockRepository();
    repository.resolvePublishedAlias.mockImplementation((alias: string) =>
      Promise.resolve(
        alias === "sculpin-fast"
          ? { catalogueEntryId: ENTRY_ID, upstreamAgentId: AGENT_UUID }
          : undefined,
      ),
    );
    const resolver =
      repository as unknown as CatalogueRepository;
    expect(await resolver.resolvePublishedAlias("sculpin-fast")).toEqual({
      catalogueEntryId: ENTRY_ID,
      upstreamAgentId: AGENT_UUID,
    });
    // An unknown / unpublished alias resolves to nothing — never a fallback agent.
    expect(await resolver.resolvePublishedAlias("unknown")).toBeUndefined();
  });
});
