import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { e2eSessionSeamPlugin, E2E_SIGN_IN_PATH } from "./e2e-auth-seam";

/**
 * Deterministic guard tests for the TEST-ONLY session seam. No DB, no network,
 * no cookie signing: we invoke the endpoint handler with a fake internal adapter
 * and assert the DEFENSIVE gates fail closed BEFORE any session is minted.
 *
 * The seam mints a session only via `internalAdapter.createSession`, so proving
 * that spy is never called on a rejected request proves no session leaks.
 */

const SEED_KEY = "e2e-session-seed-key-32chars-min-ok!!";
const USER_ID = "11111111-1111-4111-8111-111111111111";

type Endpoint = (input: {
  headers?: HeadersInit;
  body?: unknown;
  context?: unknown;
  asResponse?: boolean;
}) => Promise<unknown>;

function fakeAdapter() {
  return {
    findUserById: vi.fn(() =>
      Promise.resolve({ id: USER_ID, email: "user@example.com" }),
    ),
    findUserByEmail: vi.fn(() =>
      Promise.resolve({ user: { id: USER_ID, email: "user@example.com" } }),
    ),
    createSession: vi.fn(() => Promise.resolve({ token: "SHOULD-NOT-LEAK" })),
  };
}

function getEndpoint(): Endpoint {
  const plugin = e2eSessionSeamPlugin({ seedKey: SEED_KEY });
  const endpoints = plugin.endpoints as Record<string, unknown>;
  return endpoints.e2eSignIn as Endpoint;
}

describe("e2eSessionSeamPlugin factory", () => {
  it("throws when constructed without a >=32-char seed key", () => {
    expect(() => e2eSessionSeamPlugin({ seedKey: "short" })).toThrow(
      /seed_key/,
    );
  });

  it("defines exactly one endpoint at POST /e2e/sign-in", () => {
    const plugin = e2eSessionSeamPlugin({ seedKey: SEED_KEY });
    const endpoints = plugin.endpoints as Record<string, unknown>;
    const values = Object.values(endpoints);
    expect(values).toHaveLength(1);
    const endpoint = values[0] as {
      path?: string;
      options?: { method?: unknown };
    };
    expect(endpoint.path).toBe(E2E_SIGN_IN_PATH);
    expect(endpoint.path).toBe("/e2e/sign-in");
    expect(endpoint.options?.method).toBe("POST");
  });
});

describe("e2e sign-in handler guards (fail closed, no session leak)", () => {
  const originalFlag = process.env.E2E_TEST_AUTH;

  beforeEach(() => {
    process.env.E2E_TEST_AUTH = "1";
  });
  afterEach(() => {
    if (originalFlag === undefined) delete process.env.E2E_TEST_AUTH;
    else process.env.E2E_TEST_AUTH = originalFlag;
  });

  it("rejects (never mints) when E2E_TEST_AUTH is not exactly '1'", async () => {
    process.env.E2E_TEST_AUTH = "0";
    const adapter = fakeAdapter();
    const endpoint = getEndpoint();
    await expect(
      endpoint({
        headers: { "x-e2e-seed-key": SEED_KEY },
        body: { userId: USER_ID },
        context: { internalAdapter: adapter },
      }),
    ).rejects.toBeTruthy();
    expect(adapter.createSession).not.toHaveBeenCalled();
    expect(adapter.findUserById).not.toHaveBeenCalled();
  });

  it("rejects (never mints) when the seed-key header is missing", async () => {
    const adapter = fakeAdapter();
    const endpoint = getEndpoint();
    await expect(
      endpoint({
        body: { userId: USER_ID },
        context: { internalAdapter: adapter },
      }),
    ).rejects.toBeTruthy();
    expect(adapter.createSession).not.toHaveBeenCalled();
    expect(adapter.findUserById).not.toHaveBeenCalled();
  });

  it("rejects (never mints) when the seed-key header is wrong", async () => {
    const adapter = fakeAdapter();
    const endpoint = getEndpoint();
    await expect(
      endpoint({
        headers: { "x-e2e-seed-key": "wrong-key-of-the-same-length!!!!!!!!!" },
        body: { userId: USER_ID },
        context: { internalAdapter: adapter },
      }),
    ).rejects.toBeTruthy();
    expect(adapter.createSession).not.toHaveBeenCalled();
    expect(adapter.findUserById).not.toHaveBeenCalled();
  });

  it("rejects (never mints) when the seed key differs only in length", async () => {
    const adapter = fakeAdapter();
    const endpoint = getEndpoint();
    await expect(
      endpoint({
        headers: { "x-e2e-seed-key": `${SEED_KEY}-extra` },
        body: { userId: USER_ID },
        context: { internalAdapter: adapter },
      }),
    ).rejects.toBeTruthy();
    expect(adapter.createSession).not.toHaveBeenCalled();
  });

  it("rejects a body with neither userId nor email (validation)", async () => {
    const adapter = fakeAdapter();
    const endpoint = getEndpoint();
    await expect(
      endpoint({
        headers: { "x-e2e-seed-key": SEED_KEY },
        body: {},
        context: { internalAdapter: adapter },
      }),
    ).rejects.toBeTruthy();
    expect(adapter.createSession).not.toHaveBeenCalled();
  });

  it("rejects (never mints) when the seeded principal does not exist", async () => {
    const adapter = fakeAdapter();
    adapter.findUserById.mockResolvedValueOnce(
      null as unknown as { id: string; email: string },
    );
    const endpoint = getEndpoint();
    await expect(
      endpoint({
        headers: { "x-e2e-seed-key": SEED_KEY },
        body: { userId: USER_ID },
        context: { internalAdapter: adapter },
      }),
    ).rejects.toBeTruthy();
    expect(adapter.findUserById).toHaveBeenCalledTimes(1);
    expect(adapter.createSession).not.toHaveBeenCalled();
  });
});
