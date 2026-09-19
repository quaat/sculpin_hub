import { describe, expect, it, vi } from "vitest";
import {
  personalOrganizationSlug,
  provisionPersonalTenant,
  type ProvisioningTx,
} from "./provisioning";

/**
 * Deterministic tests for the transaction-bound provisioning building block.
 * A fake transaction client records the query sequence; no live database. The
 * user + account rows are created by Better Auth earlier in the SAME
 * transaction (see the atomic wiring in auth.ts), so this block only inserts
 * org + membership + audit + outbox for an already-existing user.
 */

function fakeTx(existingOrgId: string | null, insertedOrgId: string) {
  const queries: string[] = [];
  const executes: string[] = [];
  let queryCall = 0;
  const $queryRaw = vi.fn((strings: TemplateStringsArray) => {
    queries.push(strings.join("?"));
    queryCall += 1;
    // First $queryRaw is the "existing personal org" lookup.
    if (queryCall === 1)
      return Promise.resolve(existingOrgId ? [{ id: existingOrgId }] : []);
    // Second $queryRaw is the org INSERT ... RETURNING id.
    return Promise.resolve([{ id: insertedOrgId }]);
  });
  const $executeRaw = vi.fn((strings: TemplateStringsArray) => {
    executes.push(strings.join("?"));
    return Promise.resolve(1);
  });
  const tx = { $queryRaw, $executeRaw } as unknown as ProvisioningTx;
  return { tx, queries, executes, $queryRaw, $executeRaw };
}

const userId = "11111111-1111-4111-8111-111111111111";
const input = {
  userId,
  organizationSlug: personalOrganizationSlug(),
  requestId: "signup-req-123",
};

describe("personalOrganizationSlug", () => {
  it("produces a DNS-label slug within the 63-char limit", () => {
    const slug = personalOrganizationSlug();
    expect(slug).toMatch(/^p-[0-9a-f]{20}$/);
    expect(slug.length).toBeLessThanOrEqual(63);
  });

  it("is unique across calls", () => {
    expect(personalOrganizationSlug()).not.toBe(personalOrganizationSlug());
  });
});

describe("provisionPersonalTenant", () => {
  it("inserts org, membership, audit, outbox, and a trial subscription for an existing user", async () => {
    const orgId = "22222222-2222-4222-8222-222222222222";
    const { tx, executes, $queryRaw, $executeRaw } = fakeTx(null, orgId);

    const result = await provisionPersonalTenant(tx, input);

    expect(result).toEqual({ userId, organizationId: orgId, created: true });
    // 1 lookup + 1 org INSERT ... RETURNING.
    expect($queryRaw).toHaveBeenCalledTimes(2);
    // membership, audit, outbox, trial subscription.
    expect($executeRaw).toHaveBeenCalledTimes(4);
    const flat = executes.join("\n");
    expect(flat).toContain("organization_memberships");
    expect(flat).toContain("audit_events");
    expect(flat).toContain("outbox_events");
    expect(flat).toContain("subscriptions");
  });

  it("tolerates a concurrent race: no INSERT row, re-reads the winner's org", async () => {
    const orgId = "44444444-4444-4444-8444-444444444444";
    // Lookup miss (1st $queryRaw -> []), INSERT ... ON CONFLICT returns nothing
    // (2nd -> []), then the race re-SELECT finds the winner (3rd -> [{orgId}]).
    let q = 0;
    const responses = [[], [], [{ id: orgId }]];
    const $queryRaw = vi.fn(() => Promise.resolve(responses[q++] ?? []));
    const $executeRaw = vi.fn(() => Promise.resolve(1));
    const tx = { $queryRaw, $executeRaw } as unknown as ProvisioningTx;

    const result = await provisionPersonalTenant(tx, input);

    expect(result).toEqual({ userId, organizationId: orgId, created: false });
    expect($queryRaw).toHaveBeenCalledTimes(3);
    // The winner already wrote membership/audit/outbox; we must not duplicate.
    expect($executeRaw).not.toHaveBeenCalled();
  });

  it("fails closed if the INSERT and the race re-read both return nothing", async () => {
    let q = 0;
    const responses: unknown[][] = [[], [], []];
    const $queryRaw = vi.fn(() => Promise.resolve(responses[q++] ?? []));
    const $executeRaw = vi.fn(() => Promise.resolve(1));
    const tx = { $queryRaw, $executeRaw } as unknown as ProvisioningTx;

    await expect(provisionPersonalTenant(tx, input)).rejects.toThrow(
      /organization_insert_failed/,
    );
    expect($executeRaw).not.toHaveBeenCalled();
  });

  it("is idempotent: returns the existing org without writing", async () => {
    const orgId = "33333333-3333-4333-8333-333333333333";
    const { tx, $queryRaw, $executeRaw } = fakeTx(orgId, "unused");

    const result = await provisionPersonalTenant(tx, input);

    expect(result).toEqual({ userId, organizationId: orgId, created: false });
    // Only the lookup ran; no INSERTs.
    expect($queryRaw).toHaveBeenCalledTimes(1);
    expect($executeRaw).not.toHaveBeenCalled();
  });

  it("rejects an invalid user id before touching the transaction", async () => {
    const { tx, $queryRaw } = fakeTx(null, "unused");
    await expect(
      provisionPersonalTenant(tx, { ...input, userId: "not-a-uuid" }),
    ).rejects.toBeInstanceOf(Error);
    expect($queryRaw).not.toHaveBeenCalled();
  });

  it("rejects an invalid slug before touching the transaction", async () => {
    const { tx, $queryRaw } = fakeTx(null, "unused");
    await expect(
      provisionPersonalTenant(tx, { ...input, organizationSlug: "Not Valid" }),
    ).rejects.toBeInstanceOf(Error);
    expect($queryRaw).not.toHaveBeenCalled();
  });
});
