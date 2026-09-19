import { describe, expect, it, vi } from "vitest";
import type { CatalogueEntry, CatalogueRepository } from "@sculpin/domain";
import {
  CatalogueInputError,
  createCatalogueEntry,
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
