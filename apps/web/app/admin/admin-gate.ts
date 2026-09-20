import { notFound } from "next/navigation";
import { requireAdmin } from "../lib/session";
import { AuthzError } from "../lib/session";

/**
 * Server-side admin gate for admin PAGES (web-control-plane rule: admin-only
 * surfaces are gated by the SERVER; client-side hiding is never a control).
 *
 * Calls the canonical `requireAdmin` (which re-derives the platform role from
 * the `users` row, never the session). On ANY AuthzError — unauthenticated, a
 * non-admin, an inactive user — it renders a 404 via `notFound()` so the page
 * does not even reveal that an admin surface exists. Non-authz errors propagate.
 * Returns `true` only when the caller is a live, active admin.
 */
export async function ensureAdminPage(): Promise<true> {
  try {
    await requireAdmin();
    return true;
  } catch (error) {
    if (error instanceof AuthzError) {
      notFound();
    }
    throw error;
  }
}
