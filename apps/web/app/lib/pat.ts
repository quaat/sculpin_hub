import { PostgresPatService, type PrismaClientLike } from "@sculpin/db";
import type {
  MintedPat,
  PatIdentity,
  PatRecord,
} from "@sculpin/domain";
import { parsePatConfig } from "@sculpin/config";
import { resolveAuthDependencies } from "./auth";
import { requireUser, AuthzError, type AuthzDeps } from "./session";

/**
 * M5 Personal Access Token control-plane operations (CLAUDE.md rule 2 / ADR 007).
 *
 * Every operation is gated by `requireUser`, which re-derives the caller's
 * identity from the canonical `users` row (never the session). A PAT is always
 * scoped to the caller's PERSONAL organization; team PATs are out of scope for
 * v1 (D-016). The raw token is returned ONLY from `createPersonalAccessToken`,
 * exactly once — it is never stored, logged, or recoverable. Dependencies are
 * injectable so unit tests run without a database or the HMAC key.
 */

export type PatManagementService = Pick<
  PostgresPatService,
  "mint" | "revoke" | "listForUser"
>;

export interface PatDeps {
  readonly authz?: Partial<AuthzDeps>;
  readonly service?: PatManagementService;
  /** Resolve the caller's personal organization id (null if none). */
  readonly resolvePersonalOrganizationId?: (
    userId: string,
  ) => Promise<string | null>;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class PatInputError extends Error {
  readonly reason = "invalid_pat_id";
  constructor() {
    super("invalid_pat_id");
    this.name = "PatInputError";
  }
}

let defaultServicePromise: Promise<PostgresPatService> | undefined;

async function resolveService(
  service?: PatManagementService,
): Promise<PatManagementService> {
  if (service) return service;
  defaultServicePromise ??= (async () => {
    const { database } = resolveAuthDependencies();
    await database.ready();
    // Least privilege: the web control plane needs ONLY the PAT keyring, never
    // the data plane's upstream Sculpin URL/credential (S7 web/data-plane split).
    const { patHashKeyring } = parsePatConfig(process.env);
    return new PostgresPatService(database.pool, patHashKeyring);
  })();
  return defaultServicePromise;
}

function prismaPersonalOrgLoader(
  prisma: PrismaClientLike,
): (userId: string) => Promise<string | null> {
  return async (userId) => {
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id
      FROM organizations
      WHERE type = 'personal' AND personal_owner_user_id = ${userId}::uuid
      LIMIT 1
    `;
    return rows[0]?.id ?? null;
  };
}

let defaultOrgLoaderPromise:
  | Promise<(userId: string) => Promise<string | null>>
  | undefined;

async function resolveOrgLoader(
  loader?: (userId: string) => Promise<string | null>,
): Promise<(userId: string) => Promise<string | null>> {
  if (loader) return loader;
  defaultOrgLoaderPromise ??= (async () => {
    const { database } = resolveAuthDependencies();
    await database.ready();
    return prismaPersonalOrgLoader(database.prisma);
  })();
  return defaultOrgLoaderPromise;
}

export interface CreatePatInput {
  readonly name: string;
  readonly expiresAt?: Date;
  /**
   * Optional IMMUTABLE catalogue-entry scopes to narrow the token to. Empty /
   * omitted = unscoped (inherit the caller's full entitlement). Existence is
   * validated atomically in the mint transaction.
   */
  readonly scopeCatalogueEntryIds?: readonly string[];
  /** Safe correlation id stamped on the §10 `pat.minted` audit event. */
  readonly requestId: string;
}

/**
 * Mint a PAT for the caller's personal organization. Returns the raw token
 * ONCE (never persisted/logged/recoverable) alongside the stored record. Throws
 * `AuthzError("organization_not_found")` if the caller has no personal org.
 */
export async function createPersonalAccessToken(
  input: CreatePatInput,
  deps?: PatDeps,
): Promise<MintedPat> {
  const ctx = await requireUser(deps?.authz);
  const loadOrg = await resolveOrgLoader(deps?.resolvePersonalOrganizationId);
  const organizationId = await loadOrg(ctx.user.id);
  if (!organizationId) throw new AuthzError("organization_not_found");
  const service = await resolveService(deps?.service);
  return service.mint({
    userId: ctx.user.id,
    organizationId,
    name: input.name,
    requestId: input.requestId,
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    ...(input.scopeCatalogueEntryIds !== undefined
      ? { scopeCatalogueEntryIds: input.scopeCatalogueEntryIds }
      : {}),
  });
}

/**
 * Revoke one of the caller's own PATs. Scoped to the owner in SQL, so a caller
 * can never revoke another user's token. Returns `undefined` if the token does
 * not exist or is already revoked (idempotent).
 */
export async function revokePersonalAccessToken(
  id: string,
  requestId: string,
  deps?: PatDeps,
): Promise<PatRecord | undefined> {
  const ctx = await requireUser(deps?.authz);
  if (!uuidPattern.test(id)) throw new PatInputError();
  const service = await resolveService(deps?.service);
  return service.revoke(id, ctx.user.id, requestId);
}

/** List the caller's own PATs (metadata only; never a secret or digest). */
export async function listPersonalAccessTokens(
  deps?: PatDeps,
): Promise<readonly PatRecord[]> {
  const ctx = await requireUser(deps?.authz);
  const service = await resolveService(deps?.service);
  return service.listForUser(ctx.user.id);
}

export type { MintedPat, PatIdentity, PatRecord };
