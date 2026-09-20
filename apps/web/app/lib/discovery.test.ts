import { describe, expect, it } from "vitest";
import {
  DiscoveryError,
  discoverSculpinAgents,
  type DiscoveryDeps,
  type DiscoveryFetch,
} from "./discovery";
import { AuthzError, type AuthzDeps, type Session } from "./session";

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const UPSTREAM_URL = "http://sculpin.internal:8001";
const DISCOVERY_KEY = "sk-discovery-unit-canary-secret";
const AGENT_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

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

const config = {
  sculpinUpstreamUrl: UPSTREAM_URL,
  sculpinDiscoveryApiKey: DISCOVERY_KEY,
};

function modelListResponse(): Response {
  return new Response(
    JSON.stringify({
      object: "list",
      data: [
        { id: "support", object: "model", created: 1720000000, owned_by: "exodus" },
        { id: AGENT_UUID, object: "model", created: 1720000000, owned_by: "exodus" },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

/**
 * A counting fake `fetch` (no vitest `vi.fn`, to avoid `any`-typed mock args).
 * `respond` receives no arguments and returns the fake Response (or throws for
 * the network-error cases). Every call is recorded for assertions.
 */
function fakeFetch(respond: () => Response): {
  fetchImpl: DiscoveryFetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchImpl: DiscoveryFetch = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(respond());
  };
  return { fetchImpl, calls };
}

function depsWith(
  role: "user" | "admin" | "none",
  fetchImpl: DiscoveryFetch,
): DiscoveryDeps {
  return { authz: authzFor(role), config, fetchImpl };
}

describe("discoverSculpinAgents", () => {
  it("returns parsed agents for an admin with a contract-shaped list", async () => {
    const { fetchImpl } = fakeFetch(() => modelListResponse());
    const agents = await discoverSculpinAgents(depsWith("admin", fetchImpl));
    expect(agents.map((a) => a.id)).toEqual(["support", AGENT_UUID]);
    expect(agents.find((a) => a.id === AGENT_UUID)?.isUuid).toBe(true);
  });

  it("injects the discovery bearer and NEVER forwards a caller credential", async () => {
    const { fetchImpl, calls } = fakeFetch(() => modelListResponse());
    await discoverSculpinAgents(depsWith("admin", fetchImpl));
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(`${UPSTREAM_URL}/v1/models`);
    const headers = (call.init.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${DISCOVERY_KEY}`);
    expect(headers.cookie).toBeUndefined();
    expect(call.init.method).toBe("GET");
  });

  it("denies a non-admin via AuthzError and never calls upstream", async () => {
    const { fetchImpl, calls } = fakeFetch(() => modelListResponse());
    await expect(
      discoverSculpinAgents(depsWith("user", fetchImpl)),
    ).rejects.toBeInstanceOf(AuthzError);
    expect(calls).toHaveLength(0);
  });

  it("denies an unauthenticated caller and never calls upstream", async () => {
    const { fetchImpl, calls } = fakeFetch(() => modelListResponse());
    await expect(
      discoverSculpinAgents(depsWith("none", fetchImpl)),
    ).rejects.toBeInstanceOf(AuthzError);
    expect(calls).toHaveLength(0);
  });

  it("fails closed on an upstream 500", async () => {
    const { fetchImpl } = fakeFetch(
      () => new Response("upstream boom", { status: 500 }),
    );
    await expect(
      discoverSculpinAgents(depsWith("admin", fetchImpl)),
    ).rejects.toBeInstanceOf(DiscoveryError);
  });

  it("fails closed on a network error", async () => {
    const { fetchImpl } = fakeFetch(() => {
      throw new Error(`connect ECONNREFUSED ${UPSTREAM_URL}`);
    });
    await expect(
      discoverSculpinAgents(depsWith("admin", fetchImpl)),
    ).rejects.toBeInstanceOf(DiscoveryError);
  });

  it("fails closed on a malformed body", async () => {
    const { fetchImpl } = fakeFetch(
      () =>
        new Response(JSON.stringify({ object: "not-a-list" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(
      discoverSculpinAgents(depsWith("admin", fetchImpl)),
    ).rejects.toBeInstanceOf(DiscoveryError);
  });

  it("never leaks the URL or key in a thrown error", async () => {
    const { fetchImpl } = fakeFetch(() => {
      throw new Error(`connect failed to ${UPSTREAM_URL} using ${DISCOVERY_KEY}`);
    });
    let message = "";
    try {
      await discoverSculpinAgents(depsWith("admin", fetchImpl));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("discovery_upstream_unavailable");
    expect(message).not.toContain(UPSTREAM_URL);
    expect(message).not.toContain(DISCOVERY_KEY);
  });

  it("never leaks the URL or key in the returned value", async () => {
    const { fetchImpl } = fakeFetch(() => modelListResponse());
    const agents = await discoverSculpinAgents(depsWith("admin", fetchImpl));
    const serialized = JSON.stringify(agents);
    expect(serialized).not.toContain(UPSTREAM_URL);
    expect(serialized).not.toContain(DISCOVERY_KEY);
  });
});
