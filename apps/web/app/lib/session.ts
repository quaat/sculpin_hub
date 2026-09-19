import { headers } from "next/headers";
import { getAuth, resolveAuthDependencies } from "./auth";
import type { PrismaClientLike } from "@sculpin/db";

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

/**
 * Server-side authorization primitives (M2 hardening).
 *
 * A valid Better Auth session proves only that the cookie resolves to a live
 * `sessions` row — it does NOT prove the account is still allowed to act. These
 * primitives re-derive authorization from the CANONICAL database state on every
 * call (fail closed):
 *   - `requireUser`         → the user exists and `users.status = 'active'`.
 *   - `requireAdmin`        → the above AND `users.role = 'admin'`.
 *   - `requireOrganization` → the above AND an ACTIVE membership in an ACTIVE
 *                             organization.
 * The session's `user` fields are treated as an untrusted hint; the row read
 * here is the source of truth. This defends against a stale session outliving a
 * deactivation, demotion, membership revocation, or org suspension.
 */

export type PlatformRole = "user" | "admin";
export type UserStatus = "active" | "deactivated";
export type OrganizationType = "personal" | "team";
export type OrganizationStatus = "active" | "suspended";
export type MembershipRole = "owner" | "member";
export type MembershipStatus = "active" | "inactive";

export type AuthzReason =
  | "unauthenticated"
  | "user_not_found"
  | "user_inactive"
  | "forbidden"
  | "organization_not_found"
  | "organization_inactive"
  | "not_a_member"
  | "membership_inactive";

/**
 * Thrown when authorization fails. Carries a stable machine `reason` (never a
 * secret) so callers can map to an HTTP status without leaking canonical state.
 */
export class AuthzError extends Error {
  readonly reason: AuthzReason;
  constructor(reason: AuthzReason) {
    super(reason);
    this.name = "AuthzError";
    this.reason = reason;
  }
}

export interface CanonicalUser {
  readonly id: string;
  readonly role: PlatformRole;
  readonly status: UserStatus;
  readonly normalizedEmail: string;
  readonly displayName: string;
}

export interface CanonicalOrganization {
  readonly id: string;
  readonly slug: string;
  readonly type: OrganizationType;
  readonly status: OrganizationStatus;
}

export interface CanonicalMembership {
  readonly role: MembershipRole;
  readonly status: MembershipStatus;
}

export interface AuthzContext {
  readonly session: Session;
  readonly user: CanonicalUser;
}

export interface OrganizationAuthzContext extends AuthzContext {
  readonly organization: CanonicalOrganization;
  readonly membership: CanonicalMembership;
}

/**
 * Canonical-state reader. Abstracted so the primitives can be unit tested with
 * an in-memory store and no live database.
 */
export interface AuthzStore {
  loadUserById(id: string): Promise<CanonicalUser | null>;
  loadOrgWithMembership(
    organizationId: string,
    userId: string,
  ): Promise<{
    organization: CanonicalOrganization | null;
    membership: CanonicalMembership | null;
  }>;
}

export interface AuthzDeps {
  readonly loadSession: () => Promise<Session | null>;
  readonly store: AuthzStore;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function prismaAuthzStore(prisma: PrismaClientLike): AuthzStore {
  return {
    async loadUserById(id) {
      const rows = await prisma.$queryRaw<
        {
          id: string;
          role: PlatformRole;
          status: UserStatus;
          normalized_email: string;
          display_name: string;
        }[]
      >`
        SELECT id, role, status, normalized_email, display_name
        FROM users
        WHERE id = ${id}::uuid
        LIMIT 1
      `;
      const row = rows[0];
      if (!row) return null;
      return {
        id: row.id,
        role: row.role,
        status: row.status,
        normalizedEmail: row.normalized_email,
        displayName: row.display_name,
      };
    },
    async loadOrgWithMembership(organizationId, userId) {
      const orgRows = await prisma.$queryRaw<
        {
          id: string;
          slug: string;
          type: OrganizationType;
          status: OrganizationStatus;
        }[]
      >`
        SELECT id, slug, type, status
        FROM organizations
        WHERE id = ${organizationId}::uuid
        LIMIT 1
      `;
      const org = orgRows[0];
      if (!org) return { organization: null, membership: null };
      const memberRows = await prisma.$queryRaw<
        { role: MembershipRole; status: MembershipStatus }[]
      >`
        SELECT role, status
        FROM organization_memberships
        WHERE organization_id = ${organizationId}::uuid
          AND user_id = ${userId}::uuid
        LIMIT 1
      `;
      const member = memberRows[0] ?? null;
      return {
        organization: {
          id: org.id,
          slug: org.slug,
          type: org.type,
          status: org.status,
        },
        membership: member,
      };
    },
  };
}

let defaultDepsPromise: Promise<AuthzDeps> | undefined;

async function resolveDefaultDeps(): Promise<AuthzDeps> {
  defaultDepsPromise ??= (async () => {
    const { database } = resolveAuthDependencies();
    await database.ready();
    return {
      loadSession: getSession,
      store: prismaAuthzStore(database.prisma),
    } satisfies AuthzDeps;
  })();
  return defaultDepsPromise;
}

/**
 * Merge caller-supplied deps over the DB-backed defaults, resolving the (async,
 * DB-connecting) defaults ONLY for the pieces the caller did not provide. Fully
 * injected deps (unit tests) therefore never touch the database.
 */
async function resolveDeps(deps?: Partial<AuthzDeps>): Promise<AuthzDeps> {
  if (deps?.loadSession && deps.store) {
    return { loadSession: deps.loadSession, store: deps.store };
  }
  const base = await resolveDefaultDeps();
  return { ...base, ...deps };
}

/**
 * Require an authenticated, ACTIVE user. Re-reads `users` on every call so a
 * deactivated account with a still-valid cookie is rejected. Throws
 * `AuthzError` on any failure; never returns a partially-authorized context.
 */
export async function requireUser(
  deps?: Partial<AuthzDeps>,
): Promise<AuthzContext> {
  const { loadSession, store } = await resolveDeps(deps);
  const session = await loadSession();
  const userId = session?.user?.id;
  if (!session || typeof userId !== "string" || !uuidPattern.test(userId)) {
    throw new AuthzError("unauthenticated");
  }
  const user = await store.loadUserById(userId);
  if (!user) throw new AuthzError("user_not_found");
  if (user.status !== "active") throw new AuthzError("user_inactive");
  return { session, user };
}

/**
 * Require an authenticated, active user whose CANONICAL platform role is admin.
 * The session/JWT role claim is never trusted; the `users.role` column is.
 */
export async function requireAdmin(
  deps?: Partial<AuthzDeps>,
): Promise<AuthzContext> {
  const ctx = await requireUser(deps);
  if (ctx.user.role !== "admin") throw new AuthzError("forbidden");
  return ctx;
}

/**
 * Require an authenticated, active user with an ACTIVE membership in an ACTIVE
 * organization. Establishes the tenant context for org-scoped operations.
 */
export async function requireOrganization(
  organizationId: string,
  deps?: Partial<AuthzDeps>,
): Promise<OrganizationAuthzContext> {
  const resolved = await resolveDeps(deps);
  const ctx = await requireUser(resolved);
  if (!uuidPattern.test(organizationId)) {
    throw new AuthzError("organization_not_found");
  }
  const { organization, membership } = await resolved.store.loadOrgWithMembership(
    organizationId,
    ctx.user.id,
  );
  if (!organization) throw new AuthzError("organization_not_found");
  if (organization.status !== "active") {
    throw new AuthzError("organization_inactive");
  }
  if (!membership) throw new AuthzError("not_a_member");
  if (membership.status !== "active") {
    throw new AuthzError("membership_inactive");
  }
  return { ...ctx, organization, membership };
}
