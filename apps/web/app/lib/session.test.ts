import { describe, expect, it } from "vitest";
import {
  AuthzError,
  requireAdmin,
  requireOrganization,
  requireUser,
  type AuthzDeps,
  type AuthzStore,
  type CanonicalMembership,
  type CanonicalOrganization,
  type CanonicalUser,
  type Session,
} from "./session";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

function sessionFor(id: string | undefined): Session {
  return { user: id ? { id } : {} } as unknown as Session;
}

function makeDeps(overrides: {
  session?: Session | null;
  user?: CanonicalUser | null;
  organization?: CanonicalOrganization | null;
  membership?: CanonicalMembership | null;
}): AuthzDeps {
  const store: AuthzStore = {
    loadUserById: () =>
      Promise.resolve(
        overrides.user === undefined ? activeUser() : overrides.user,
      ),
    loadOrgWithMembership: () =>
      Promise.resolve({
        organization:
          overrides.organization === undefined
            ? activeOrg()
            : overrides.organization,
        membership:
          overrides.membership === undefined
            ? activeMembership()
            : overrides.membership,
      }),
  };
  return {
    loadSession: () =>
      Promise.resolve(
        overrides.session === undefined
          ? sessionFor(USER_ID)
          : overrides.session,
      ),
    store,
  };
}

function activeUser(role: "user" | "admin" = "user"): CanonicalUser {
  return {
    id: USER_ID,
    role,
    status: "active",
    normalizedEmail: "a@example.com",
    displayName: "A",
  };
}
function activeOrg(): CanonicalOrganization {
  return { id: ORG_ID, slug: "p-x", type: "personal", status: "active" };
}
function activeMembership(): CanonicalMembership {
  return { role: "owner", status: "active" };
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

describe("requireUser", () => {
  it("rejects when there is no session (a cookie alone is not enough)", async () => {
    expect(await reasonOf(() => requireUser(makeDeps({ session: null })))).toBe(
      "unauthenticated",
    );
  });

  it("rejects a session whose user id is not a uuid", async () => {
    expect(
      await reasonOf(() =>
        requireUser(makeDeps({ session: sessionFor("not-a-uuid") })),
      ),
    ).toBe("unauthenticated");
  });

  it("rejects when the canonical user row no longer exists", async () => {
    expect(await reasonOf(() => requireUser(makeDeps({ user: null })))).toBe(
      "user_not_found",
    );
  });

  it("rejects a deactivated user even with a valid session", async () => {
    expect(
      await reasonOf(() =>
        requireUser(
          makeDeps({ user: { ...activeUser(), status: "deactivated" } }),
        ),
      ),
    ).toBe("user_inactive");
  });

  it("returns the canonical user for an active account", async () => {
    const ctx = await requireUser(makeDeps({}));
    expect(ctx.user.id).toBe(USER_ID);
    expect(ctx.user.status).toBe("active");
  });
});

describe("requireAdmin", () => {
  it("rejects an active non-admin user (role read from the DB, not the session)", async () => {
    expect(
      await reasonOf(() => requireAdmin(makeDeps({ user: activeUser("user") }))),
    ).toBe("forbidden");
  });

  it("allows an active admin", async () => {
    const ctx = await requireAdmin(makeDeps({ user: activeUser("admin") }));
    expect(ctx.user.role).toBe("admin");
  });
});

describe("requireOrganization", () => {
  it("rejects an unknown organization", async () => {
    expect(
      await reasonOf(() =>
        requireOrganization(ORG_ID, makeDeps({ organization: null })),
      ),
    ).toBe("organization_not_found");
  });

  it("rejects a malformed organization id without hitting the store", async () => {
    expect(
      await reasonOf(() => requireOrganization("nope", makeDeps({}))),
    ).toBe("organization_not_found");
  });

  it("rejects a suspended organization", async () => {
    expect(
      await reasonOf(() =>
        requireOrganization(
          ORG_ID,
          makeDeps({ organization: { ...activeOrg(), status: "suspended" } }),
        ),
      ),
    ).toBe("organization_inactive");
  });

  it("rejects a user who is not a member", async () => {
    expect(
      await reasonOf(() =>
        requireOrganization(ORG_ID, makeDeps({ membership: null })),
      ),
    ).toBe("not_a_member");
  });

  it("rejects an inactive membership", async () => {
    expect(
      await reasonOf(() =>
        requireOrganization(
          ORG_ID,
          makeDeps({
            membership: { ...activeMembership(), status: "inactive" },
          }),
        ),
      ),
    ).toBe("membership_inactive");
  });

  it("returns the tenant context for an active member of an active org", async () => {
    const ctx = await requireOrganization(ORG_ID, makeDeps({}));
    expect(ctx.organization.id).toBe(ORG_ID);
    expect(ctx.membership.status).toBe("active");
    expect(ctx.user.id).toBe(USER_ID);
  });
});
