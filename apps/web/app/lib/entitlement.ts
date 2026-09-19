import { PostgresSubscriptionRepository } from "@sculpin/db";
import {
  resolveEntitlement,
  type Entitlement,
  type SubscriptionRepository,
} from "@sculpin/domain";
import { resolveAuthDependencies } from "./auth";
import {
  AuthzError,
  requireOrganization,
  type AuthzDeps,
  type OrganizationAuthzContext,
} from "./session";

/**
 * M4 entitlement resolution (control-plane read + gate).
 *
 * A valid session/PAT proves identity, not access. `/v1/*` and any metered
 * capability must additionally require an ACTIVE, in-quota entitlement — the
 * union of the tenant's active subscriptions (D-015). These helpers layer on
 * top of `requireOrganization` (which already re-derives membership from the
 * canonical DB rows) and read the subscription rows fresh on every call.
 * Dependencies are injectable so unit tests run without a database.
 */

export interface EntitlementDeps {
  readonly authz?: Partial<AuthzDeps>;
  readonly repository?: SubscriptionRepository;
  readonly now?: () => Date;
}

export interface EntitledOrganizationContext extends OrganizationAuthzContext {
  readonly entitlement: Entitlement;
}

let defaultRepositoryPromise: Promise<SubscriptionRepository> | undefined;

async function resolveRepository(
  repository?: SubscriptionRepository,
): Promise<SubscriptionRepository> {
  if (repository) return repository;
  defaultRepositoryPromise ??= (async () => {
    const { database } = resolveAuthDependencies();
    await database.ready();
    return new PostgresSubscriptionRepository(database.pool);
  })();
  return defaultRepositoryPromise;
}

/**
 * Resolve the caller's entitlement for an organization they belong to. Requires
 * an active membership in an active org, then returns the resolved entitlement
 * WITHOUT asserting it is usable — callers that need to gate access should use
 * `requireEntitledOrganization`.
 */
export async function getOrganizationEntitlement(
  organizationId: string,
  deps?: EntitlementDeps,
): Promise<EntitledOrganizationContext> {
  const ctx = await requireOrganization(organizationId, deps?.authz);
  const repository = await resolveRepository(deps?.repository);
  const subscriptions = await repository.listForOrganization(organizationId);
  const now = deps?.now?.() ?? new Date();
  const entitlement = resolveEntitlement(organizationId, subscriptions, now);
  return { ...ctx, entitlement };
}

/**
 * Gate access on a usable entitlement: an active membership in an active org
 * AND at least one active, in-window subscription with remaining quota. Throws
 * `AuthzError("no_active_subscription")` or `("quota_exhausted")` (stable
 * machine reasons, never secrets) so a caller can map to an HTTP status.
 */
export async function requireEntitledOrganization(
  organizationId: string,
  deps?: EntitlementDeps,
): Promise<EntitledOrganizationContext> {
  const ctx = await getOrganizationEntitlement(organizationId, deps);
  if (!ctx.entitlement.active) throw new AuthzError("no_active_subscription");
  if (ctx.entitlement.remainingQuota <= 0)
    throw new AuthzError("quota_exhausted");
  return ctx;
}
