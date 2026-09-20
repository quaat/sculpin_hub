import { beforeEach, describe, expect, it, vi } from "vitest";

// The action calls `revalidatePath` (a Next server-only helper) and the two lib
// seams. We mock all three so the test exercises ONLY the action's scope control
// flow — no DB, no session, no Next runtime. Vitest hoists `vi.mock`; factory
// bodies may only reference variables whose names start with `mock`.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { mockCreatePat, mockResolveScopable } = vi.hoisted(() => ({
  mockCreatePat: vi.fn(),
  mockResolveScopable: vi.fn(),
}));

vi.mock("../../lib/pat", () => ({
  PatInputError: class PatInputError extends Error {},
  createPersonalAccessToken: mockCreatePat,
  revokePersonalAccessToken: vi.fn(),
}));

vi.mock("../../lib/pat-scopes", () => ({
  resolveScopableOfferings: mockResolveScopable,
}));

import { mintTokenAction } from "./actions";

function form(entries: readonly (readonly [string, string])[]): FormData {
  const fd = new FormData();
  for (const [key, value] of entries) fd.append(key, value);
  return fd;
}

const minted = {
  token: "sclp_pat_aaaaaaaaaaaaaaaaaaaaaa_" + "b".repeat(43),
  record: { publicId: "aaaaaaaaaaaaaaaaaaaaaa", name: "cli" },
};

describe("mintTokenAction — explicit PAT scoping (§4, rules 1-2)", () => {
  beforeEach(() => {
    mockCreatePat.mockReset().mockResolvedValue(minted);
    mockResolveScopable.mockReset().mockResolvedValue([
      { catalogueEntryId: "11111111-1111-1111-1111-111111111111", publicAlias: "sculpin-pro", displayName: "Sculpin Pro", status: "published" },
      { catalogueEntryId: "22222222-2222-2222-2222-222222222222", publicAlias: "sculpin-fast", displayName: "Sculpin Fast", status: "published" },
    ]);
  });

  it("fails closed when the scope mode is omitted (never silently unscoped)", async () => {
    const result = await mintTokenAction(form([["name", "cli"]]));
    expect(result.ok).toBe(false);
    expect(mockCreatePat).not.toHaveBeenCalled();
  });

  it("mints an UNSCOPED token only when 'all' is explicitly chosen", async () => {
    const result = await mintTokenAction(
      form([
        ["name", "cli"],
        ["scopeMode", "all"],
      ]),
    );
    expect(result.ok).toBe(true);
    expect(mockCreatePat).toHaveBeenCalledTimes(1);
    const arg = mockCreatePat.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg).not.toHaveProperty("scopeCatalogueEntryIds");
    // 'all' must never trigger an entitlement re-resolution (it is unscoped).
    expect(mockResolveScopable).not.toHaveBeenCalled();
  });

  it("rejects 'selected' with no offering chosen (does not fall back to unscoped)", async () => {
    const result = await mintTokenAction(
      form([
        ["name", "cli"],
        ["scopeMode", "selected"],
      ]),
    );
    expect(result.ok).toBe(false);
    expect(mockCreatePat).not.toHaveBeenCalled();
  });

  it("maps a selected entitled alias to its immutable catalogue-entry scope id", async () => {
    const result = await mintTokenAction(
      form([
        ["name", "cli"],
        ["scopeMode", "selected"],
        ["scopeAlias", "sculpin-pro"],
      ]),
    );
    expect(result.ok).toBe(true);
    const arg = mockCreatePat.mock.calls[0]?.[0] as {
      scopeCatalogueEntryIds: string[];
    };
    expect(arg.scopeCatalogueEntryIds).toEqual([
      "11111111-1111-1111-1111-111111111111",
    ]);
  });

  it("REJECTS a forged/unentitled alias — server re-resolves entitlement, mint never runs", async () => {
    const result = await mintTokenAction(
      form([
        ["name", "cli"],
        ["scopeMode", "selected"],
        ["scopeAlias", "sculpin-pro"],
        ["scopeAlias", "not-entitled-alias"],
      ]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/not available to you/i);
    }
    expect(mockCreatePat).not.toHaveBeenCalled();
  });

  it("rejects an unknown scope mode value", async () => {
    const result = await mintTokenAction(
      form([
        ["name", "cli"],
        ["scopeMode", "everything"],
      ]),
    );
    expect(result.ok).toBe(false);
    expect(mockCreatePat).not.toHaveBeenCalled();
  });
});
