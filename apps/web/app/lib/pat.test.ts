import { describe, expect, it, vi } from "vitest";
import type { MintedPat, PatRecord } from "@sculpin/domain";
import {
  createPersonalAccessToken,
  listPersonalAccessTokens,
  revokePersonalAccessToken,
  PatInputError,
  type PatManagementService,
} from "./pat";
import { AuthzError, type AuthzDeps, type Session } from "./session";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const PAT_ID = "33333333-3333-4333-8333-333333333333";

function authzFor(
  shape: { authenticated?: boolean; userActive?: boolean } = {},
): Partial<AuthzDeps> {
  const { authenticated = true, userActive = true } = shape;
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
      loadOrgWithMembership: () =>
        Promise.resolve({ organization: null, membership: null }),
    },
  };
}

function record(overrides: Partial<PatRecord> = {}): PatRecord {
  return {
    id: PAT_ID,
    publicId: "A".repeat(22),
    userId: USER_ID,
    organizationId: ORG_ID,
    name: "laptop",
    status: "active",
    createdAt: new Date("2026-09-20T00:00:00.000Z"),
    ...overrides,
  };
}

function serviceMock(overrides: Partial<PatManagementService> = {}) {
  const minted: MintedPat = {
    record: record(),
    token: `sclp_pat_${"A".repeat(22)}_${"b".repeat(43)}`,
  };
  return {
    mint: vi.fn().mockResolvedValue(minted),
    revoke: vi.fn().mockResolvedValue(record({ status: "revoked" })),
    listForUser: vi.fn().mockResolvedValue([record()]),
    ...overrides,
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

describe("createPersonalAccessToken", () => {
  it("mints a token for the caller's personal org and returns it once", async () => {
    const service = serviceMock();
    const result = await createPersonalAccessToken(
      { name: "laptop" },
      {
        authz: authzFor(),
        service,
        resolvePersonalOrganizationId: () => Promise.resolve(ORG_ID),
      },
    );
    expect(result.token).toMatch(/^sclp_pat_/);
    expect(service.mint).toHaveBeenCalledWith({
      userId: USER_ID,
      organizationId: ORG_ID,
      name: "laptop",
    });
  });

  it("forwards an optional expiry", async () => {
    const service = serviceMock();
    const expiresAt = new Date("2026-12-31T00:00:00.000Z");
    await createPersonalAccessToken(
      { name: "temp", expiresAt },
      {
        authz: authzFor(),
        service,
        resolvePersonalOrganizationId: () => Promise.resolve(ORG_ID),
      },
    );
    expect(service.mint).toHaveBeenCalledWith({
      userId: USER_ID,
      organizationId: ORG_ID,
      name: "temp",
      expiresAt,
    });
  });

  it("rejects a caller with no personal organization before minting", async () => {
    const service = serviceMock();
    expect(
      await reasonOf(() =>
        createPersonalAccessToken(
          { name: "laptop" },
          {
            authz: authzFor(),
            service,
            resolvePersonalOrganizationId: () => Promise.resolve(null),
          },
        ),
      ),
    ).toBe("organization_not_found");
    expect(service.mint).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated caller before resolving the org or minting", async () => {
    const service = serviceMock();
    const resolvePersonalOrganizationId = vi.fn();
    expect(
      await reasonOf(() =>
        createPersonalAccessToken(
          { name: "laptop" },
          {
            authz: authzFor({ authenticated: false }),
            service,
            resolvePersonalOrganizationId,
          },
        ),
      ),
    ).toBe("unauthenticated");
    expect(resolvePersonalOrganizationId).not.toHaveBeenCalled();
    expect(service.mint).not.toHaveBeenCalled();
  });
});

describe("revokePersonalAccessToken", () => {
  it("revokes the caller's own token by id", async () => {
    const service = serviceMock();
    const revoked = await revokePersonalAccessToken(PAT_ID, {
      authz: authzFor(),
      service,
    });
    expect(revoked?.status).toBe("revoked");
    expect(service.revoke).toHaveBeenCalledWith(PAT_ID, USER_ID);
  });

  it("rejects a malformed id without touching the service", async () => {
    const service = serviceMock();
    await expect(
      revokePersonalAccessToken("not-a-uuid", { authz: authzFor(), service }),
    ).rejects.toBeInstanceOf(PatInputError);
    expect(service.revoke).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated caller", async () => {
    const service = serviceMock();
    expect(
      await reasonOf(() =>
        revokePersonalAccessToken(PAT_ID, {
          authz: authzFor({ authenticated: false }),
          service,
        }),
      ),
    ).toBe("unauthenticated");
    expect(service.revoke).not.toHaveBeenCalled();
  });
});

describe("listPersonalAccessTokens", () => {
  it("lists the caller's own tokens (metadata only)", async () => {
    const service = serviceMock();
    const list = await listPersonalAccessTokens({ authz: authzFor(), service });
    expect(list).toHaveLength(1);
    expect(service.listForUser).toHaveBeenCalledWith(USER_ID);
    // The record carries no secret/digest field.
    expect(JSON.stringify(list)).not.toMatch(/secretHash|secret_hash/);
  });

  it("rejects an unauthenticated caller", async () => {
    const service = serviceMock();
    expect(
      await reasonOf(() =>
        listPersonalAccessTokens({
          authz: authzFor({ authenticated: false }),
          service,
        }),
      ),
    ).toBe("unauthenticated");
    expect(service.listForUser).not.toHaveBeenCalled();
  });
});
