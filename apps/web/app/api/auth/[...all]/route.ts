import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "../../../lib/auth";

/**
 * Catch-all Better Auth route handler (M2 identity slice).
 *
 * `getAuth()` is resolved per request (not at module load) so importing this
 * module does not eagerly validate the auth env or touch the DB at build time;
 * the first request validates env, initializes the Prisma client, and fails
 * closed. `toNextJsHandler` bridges Better Auth's Web `Request`/`Response` onto
 * the Next.js App Router. The `nextCookies()` plugin (registered last in
 * `buildAuthOptions`) forwards Better Auth's `Set-Cookie` headers.
 */
export async function GET(request: Request): Promise<Response> {
  return toNextJsHandler(await getAuth()).GET(request);
}

export async function POST(request: Request): Promise<Response> {
  return toNextJsHandler(await getAuth()).POST(request);
}
