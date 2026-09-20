import { AuthzError, type AuthzReason } from "./session";

/**
 * S6 UI helper: run a server-side authorization/read closure and normalize its
 * outcome into a discriminated union the presentational layer can render. This
 * keeps the SERVER gate authoritative (client-side hiding is never a control):
 * a page/action calls the real `requireUser`/`requireAdmin`/`requireOrganization`
 * primitive inside `run`, and any `AuthzError` is surfaced as a stable machine
 * `reason` (never a secret / canonical state) so the page can show a safe
 * message or redirect to sign-in. Non-authz errors propagate (they are bugs /
 * infrastructure failures, not authorization decisions).
 */
export type GuardResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: AuthzReason };

export async function guard<T>(run: () => Promise<T>): Promise<GuardResult<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    if (error instanceof AuthzError) {
      return { ok: false, reason: error.reason };
    }
    throw error;
  }
}

/** True when the caller is simply not signed in (route should invite sign-in). */
export function isUnauthenticated(reason: AuthzReason): boolean {
  return reason === "unauthenticated";
}
