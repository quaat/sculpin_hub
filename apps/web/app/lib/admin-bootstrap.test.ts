import { describe, expect, it, vi } from "vitest";
import {
  isAllowlistedAdmin,
  reconcileAdminBootstrap,
  type AdminBootstrapClient,
} from "./admin-bootstrap";

/**
 * Deterministic tests for admin bootstrap. A hand-rolled fake stands in for the
 * Prisma client: `$queryRaw` returns queued result sets in order, `$executeRaw`
 * records the audit insert. No live database.
 */

function fakeClient(queryResults: unknown[][]) {
  const results = [...queryResults];
  const executes: unknown[][] = [];
  const $queryRaw = vi.fn(() => Promise.resolve(results.shift() ?? []));
  const $executeRaw = vi.fn((...args: unknown[]) => {
    executes.push(args);
    return Promise.resolve(1);
  });
  const client = {
    $queryRaw,
    $executeRaw,
  } as unknown as AdminBootstrapClient;
  return { client, executes, $queryRaw, $executeRaw };
}

const base = {
  userId: "11111111-1111-1111-1111-111111111111",
  allowlist: ["admin@example.com"],
  requestId: "req-abc-123",
};

describe("isAllowlistedAdmin", () => {
  it("returns false for an unverified email even if allowlisted", () => {
    expect(
      isAllowlistedAdmin({
        providerEmail: "admin@example.com",
        emailVerified: false,
        allowlist: ["admin@example.com"],
      }),
    ).toBe(false);
  });

  it("matches case-insensitively against the allowlist", () => {
    expect(
      isAllowlistedAdmin({
        providerEmail: "Admin@Example.com",
        emailVerified: true,
        allowlist: ["admin@example.com"],
      }),
    ).toBe(true);
  });

  it("returns false for a verified but non-allowlisted email", () => {
    expect(
      isAllowlistedAdmin({
        providerEmail: "other@example.com",
        emailVerified: true,
        allowlist: ["admin@example.com"],
      }),
    ).toBe(false);
  });
});

describe("reconcileAdminBootstrap", () => {
  it("elevates a verified allowlisted user and writes an org-scoped audit row", async () => {
    const { client, executes, $executeRaw } = fakeClient([
      [{ id: base.userId }], // UPDATE ... RETURNING id (elevated)
      [{ id: "22222222-2222-2222-2222-222222222222" }], // personal org lookup
    ]);
    const granted = await reconcileAdminBootstrap(client, {
      ...base,
      providerEmail: "admin@example.com",
      emailVerified: true,
    });
    expect(granted).toBe(true);
    expect($executeRaw).toHaveBeenCalledTimes(1);
    // The audit insert carries the system actor and the granted role.
    const flattened = JSON.stringify(executes);
    expect(flattened).toContain("admin-bootstrap");
    expect(flattened).toContain("user.role.granted");
  });

  it("does nothing for an unverified email (no update, no audit)", async () => {
    const { client, $queryRaw, $executeRaw } = fakeClient([]);
    const granted = await reconcileAdminBootstrap(client, {
      ...base,
      providerEmail: "admin@example.com",
      emailVerified: false,
    });
    expect(granted).toBe(false);
    expect($queryRaw).not.toHaveBeenCalled();
    expect($executeRaw).not.toHaveBeenCalled();
  });

  it("is idempotent: already-admin user (no rows returned) writes no audit", async () => {
    const { client, $executeRaw } = fakeClient([
      [], // UPDATE ... RETURNING id => no rows (already admin)
    ]);
    const granted = await reconcileAdminBootstrap(client, {
      ...base,
      providerEmail: "admin@example.com",
      emailVerified: true,
    });
    expect(granted).toBe(false);
    expect($executeRaw).not.toHaveBeenCalled();
  });

  it("throws when the elevated user has no personal organization yet", async () => {
    const { client } = fakeClient([
      [{ id: base.userId }], // elevated
      [], // no personal org
    ]);
    await expect(
      reconcileAdminBootstrap(client, {
        ...base,
        providerEmail: "admin@example.com",
        emailVerified: true,
      }),
    ).rejects.toThrow("admin_bootstrap_missing_personal_org");
  });
});
