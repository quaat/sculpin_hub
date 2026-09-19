import { headers } from "next/headers";
import { getAuth } from "./auth";

/**
 * Server-side session accessor (M2 identity slice).
 *
 * Reads the opaque session cookie from the incoming request headers and
 * resolves it against the database-backed session store. Because there is no
 * cookie cache (see `buildAuthOptions`), every call re-checks the `sessions`
 * row, so revocation / deactivation / "sign out everywhere" take effect on the
 * next request. Returns `null` when there is no valid session.
 *
 * Server-only: relies on `next/headers`, so it must be called from Server
 * Components, Route Handlers, or Server Actions.
 */
export async function getSession(): Promise<Session | null> {
  const requestHeaders = await headers();
  const auth = await getAuth();
  return auth.api.getSession({ headers: requestHeaders });
}

export type Session = Awaited<
  ReturnType<Awaited<ReturnType<typeof getAuth>>["api"]["getSession"]>
>;
