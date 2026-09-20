import { describe, expect, it, vi } from "vitest";

/**
 * Proves the SERVER admin gate fails closed. `ensureAdminPage` must invoke
 * `notFound()` (a 404, revealing nothing) whenever `requireAdmin` throws an
 * `AuthzError` — i.e. for a signed-out caller, a non-admin, or an inactive
 * user — so an admin page never renders admin content without a live admin
 * context. Client-side hiding is never relied upon.
 */
class NotFoundSignal extends Error {
  constructor() {
    super("NEXT_NOT_FOUND");
    this.name = "NotFoundSignal";
  }
}

describe("ensureAdminPage (server admin gate)", () => {
  it("calls notFound() when requireAdmin throws AuthzError (non-admin/signed-out)", async () => {
    vi.resetModules();
    const notFound = vi.fn(() => {
      throw new NotFoundSignal();
    });
    vi.doMock("next/navigation", () => ({ notFound }));

    const session = await import("../lib/session");
    const requireAdmin = vi
      .spyOn(session, "requireAdmin")
      .mockRejectedValue(new session.AuthzError("forbidden"));

    const { ensureAdminPage } = await import("./admin-gate");
    await expect(ensureAdminPage()).rejects.toBeInstanceOf(NotFoundSignal);
    expect(notFound).toHaveBeenCalledTimes(1);
    expect(requireAdmin).toHaveBeenCalledTimes(1);

    requireAdmin.mockRestore();
    vi.doUnmock("next/navigation");
    vi.resetModules();
  });

  it("returns true for a live admin (no notFound)", async () => {
    vi.resetModules();
    const notFound = vi.fn(() => {
      throw new NotFoundSignal();
    });
    vi.doMock("next/navigation", () => ({ notFound }));

    const session = await import("../lib/session");
    const requireAdmin = vi.spyOn(session, "requireAdmin").mockResolvedValue({
      session: null,
      user: {
        id: "00000000-0000-0000-0000-000000000000",
        role: "admin",
        status: "active",
        normalizedEmail: "admin@example.com",
        displayName: "Admin",
      },
    } as unknown as Awaited<ReturnType<typeof session.requireAdmin>>);

    const { ensureAdminPage } = await import("./admin-gate");
    await expect(ensureAdminPage()).resolves.toBe(true);
    expect(notFound).not.toHaveBeenCalled();

    requireAdmin.mockRestore();
    vi.doUnmock("next/navigation");
    vi.resetModules();
  });
});
