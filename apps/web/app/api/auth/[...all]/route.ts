import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "../../../lib/auth";

/**
 * Catch-all Better Auth route handler (M2 identity slice).
 *
 * `getAuth()` is lazy so importing this module does not eagerly validate the
 * auth env at build time; the first request validates env and fails closed.
 * `toNextJsHandler` bridges Better Auth's Web `Request`/`Response` onto the
 * Next.js App Router. The `nextCookies()` plugin (registered last in
 * `buildAuthOptions`) forwards Better Auth's `Set-Cookie` headers.
 */
export const { GET, POST } = toNextJsHandler(getAuth());
