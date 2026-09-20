import {
  PostgresPlanRepository,
  PostgresSubscriptionRepository,
  type PrismaClientLike,
} from "@sculpin/db";
import type {
  Plan,
  PlanRepository,
  Subscription,
  SubscriptionRepository,
  SubscriptionStatus,
} from "@sculpin/domain";
import { resolveAuthDependencies } from "./auth";
import {
  AuthzError,
  requireAdmin,
  requireOrganization,
  requireUser,
  type AuthzDeps,
} from "./session";

/**
 * S6 subscription control-plane operations (plans + subscriptions).
 *
 * Two distinct grant paths exist and MUST stay distinct:
 *
 *  - SELF-SERVICE (`claimSelfServicePlan`): a signed-in member claims a plan for
 *    THEIR OWN organization. Because a user chooses which plan to claim, this
 *    path additionally gates on the plan being simultaneously `enabled`,
 *    `published`, and `selfServiceEligible` (S-2 carryover). `grantFromPlan`
 *    alone only rejects a DISABLED plan, so an unpublished / admin-only plan
 *    would otherwise be self-claimable — the extra gate here fails that closed.
 *  - ADMIN (`adminGrantPlan`): an admin deliberately grants ANY enabled plan to
 *    ANY organization, including unpublished / non-self-service plans. The only
 *    eligibility gate on this path is the `enabled` check inside
 *    `grantFromPlan`; the self-service gate is intentionally NOT applied.
 *
 * Dependencies are injectable so unit tests run without a database.
 */

export interface SubscriptionDeps {
  readonly authz?: Partial<AuthzDeps>;
  readonly planRepository?: PlanRepository;
  readonly subscriptionRepository?: SubscriptionRepository;
  /**
   * Resolve the caller's personal organization id (null if none). Injected in
   * unit tests; defaults to a DB-backed lookup. Used only by the caller-scoped
   * convenience wrappers so the UI never has to know / pass an org id.
   */
  readonly resolvePersonalOrganizationId?: (
    userId: string,
  ) => Promise<string | null>;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Thrown when a self-service claim is refused. Carries a stable machine reason
 * only (never a secret / canonical detail):
 *   - `plan_not_available`   → the plan id does not resolve to any plan.
 *   - `plan_not_self_service` → the plan exists but is not simultaneously
 *     enabled + published + self-service-eligible, so it MUST NOT be claimable
 *     through the self-service path.
 */
export class SelfServiceClaimError extends Error {
  readonly reason: "plan_not_available" | "plan_not_self_service";
  constructor(reason: "plan_not_available" | "plan_not_self_service") {
    super(reason);
    this.name = "SelfServiceClaimError";
    this.reason = reason;
  }
}

/**
 * Thrown for malformed ids before any repository access:
 *   - `invalid_subscription_id` → a bad subscription id (status transition).
 *   - `invalid_grant_input`     → a bad organization / plan id (admin grant).
 */
export class SubscriptionInputError extends Error {
  readonly reason: "invalid_subscription_id" | "invalid_grant_input";
  constructor(
    reason: "invalid_subscription_id" | "invalid_grant_input" = "invalid_subscription_id",
  ) {
    super(reason);
    this.name = "SubscriptionInputError";
    this.reason = reason;
  }
}

let defaultPlanRepositoryPromise: Promise<PlanRepository> | undefined;

async function resolvePlanRepository(
  repository?: PlanRepository,
): Promise<PlanRepository> {
  if (repository) return repository;
  defaultPlanRepositoryPromise ??= (async () => {
    const { database } = resolveAuthDependencies();
    await database.ready();
    return new PostgresPlanRepository(database.pool);
  })();
  return defaultPlanRepositoryPromise;
}

let defaultSubscriptionRepositoryPromise:
  | Promise<SubscriptionRepository>
  | undefined;

async function resolveSubscriptionRepository(
  repository?: SubscriptionRepository,
): Promise<SubscriptionRepository> {
  if (repository) return repository;
  defaultSubscriptionRepositoryPromise ??= (async () => {
    const { database } = resolveAuthDependencies();
    await database.ready();
    return new PostgresSubscriptionRepository(database.pool);
  })();
  return defaultSubscriptionRepositoryPromise;
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

/**
 * Signed-in product/plan browsing: the plans a user may self-claim. Requires an
 * authenticated, active user (not admin). The repository query already filters
 * to `enabled AND published AND self_service_eligible`.
 */
export async function listSelfServicePlans(
  deps?: SubscriptionDeps,
): Promise<readonly Plan[]> {
  await requireUser(deps?.authz);
  const planRepository = await resolvePlanRepository(deps?.planRepository);
  return planRepository.listSelfServicePublished();
}

/**
 * List an organization's subscriptions. Requires an ACTIVE membership in the
 * ACTIVE organization (the caller may only read their own tenant's rows).
 */
export async function listOrganizationSubscriptions(
  organizationId: string,
  deps?: SubscriptionDeps,
): Promise<readonly Subscription[]> {
  await requireOrganization(organizationId, deps?.authz);
  const subscriptionRepository = await resolveSubscriptionRepository(
    deps?.subscriptionRepository,
  );
  return subscriptionRepository.listForOrganization(organizationId);
}

/**
 * S-2 SECURITY CARRYOVER — self-service plan claim. Fail-closed, IN ORDER:
 *
 *   1. `requireOrganization` — the caller MUST be an active member of the given
 *      ACTIVE organization. A user can only claim for THEIR own org, never an
 *      arbitrary org id.
 *   2. Load the plan; an unknown id fails closed with `plan_not_available`.
 *   3. GATE: the plan must be `enabled && published && selfServiceEligible`. If
 *      ANY is false, fail closed with `plan_not_self_service` — an admin-only /
 *      unpublished / disabled plan is never self-claimable. This is stricter
 *      than `grantFromPlan`, which only checks `enabled`.
 *   4. Grant via the repository (one transaction, snapshotting kind + offerings).
 *      A one-time plan already claimed surfaces as
 *      `DomainConflictError("plan_already_claimed")`, which propagates.
 */
export async function claimSelfServicePlan(
  input: { readonly organizationId: string; readonly planId: string },
  deps?: SubscriptionDeps,
): Promise<Subscription> {
  const ctx = await requireOrganization(input.organizationId, deps?.authz);
  // Shape-check the id before the lookup (consistent with the other id paths).
  // A malformed id could never match a plan anyway (findById is parameterized),
  // so it fails closed as an unavailable plan.
  if (!uuidPattern.test(input.planId))
    throw new SelfServiceClaimError("plan_not_available");
  const planRepository = await resolvePlanRepository(deps?.planRepository);
  const plan = await planRepository.findById(input.planId);
  if (!plan) throw new SelfServiceClaimError("plan_not_available");
  if (
    plan.enabled !== true ||
    plan.published !== true ||
    plan.selfServiceEligible !== true
  )
    throw new SelfServiceClaimError("plan_not_self_service");
  const subscriptionRepository = await resolveSubscriptionRepository(
    deps?.subscriptionRepository,
  );
  return subscriptionRepository.grantFromPlan(
    input.organizationId,
    input.planId,
    ctx.user.id,
  );
}

/**
 * RAW admin grant primitive. An admin may grant ANY plan the repository accepts
 * (the `enabled`-only gate lives in `grantFromPlan`) to ANY organization,
 * INCLUDING unpublished / non-self-service plans — this is deliberate: the
 * self-service gate in `claimSelfServicePlan` is NOT applied here. Gated by
 * `requireAdmin`, which re-derives the platform role from the canonical `users`
 * row (never the session).
 */
export async function adminGrantPlan(
  input: { readonly organizationId: string; readonly planId: string },
  deps?: SubscriptionDeps,
): Promise<Subscription> {
  const ctx = await requireAdmin(deps?.authz);
  // Defense-in-depth shape check before the repository (the grant fails closed
  // on a bad plan/org anyway, but keep the admin path consistent).
  if (
    !uuidPattern.test(input.organizationId) ||
    !uuidPattern.test(input.planId)
  )
    throw new SubscriptionInputError("invalid_grant_input");
  const subscriptionRepository = await resolveSubscriptionRepository(
    deps?.subscriptionRepository,
  );
  return subscriptionRepository.grantFromPlan(
    input.organizationId,
    input.planId,
    ctx.user.id,
  );
}

/**
 * Admin: transition a subscription through the state machine (suspend / resume /
 * terminal). Gated by `requireAdmin`; the subscription id is validated as a
 * uuid before any repository access (fail closed on bad input). Returns
 * `undefined` when the repository performed no update (illegal transition or the
 * subscription was not found) — the repository owns the state machine.
 */
export async function adminSetSubscriptionStatus(
  input: {
    readonly subscriptionId: string;
    readonly status: SubscriptionStatus;
  },
  deps?: SubscriptionDeps,
): Promise<Subscription | undefined> {
  await requireAdmin(deps?.authz);
  if (!uuidPattern.test(input.subscriptionId)) throw new SubscriptionInputError();
  const subscriptionRepository = await resolveSubscriptionRepository(
    deps?.subscriptionRepository,
  );
  return subscriptionRepository.setStatus(input.subscriptionId, input.status);
}

// ---------------------------------------------------------------------------
// Caller-scoped convenience wrappers (used by the S6 UI / server actions). They
// resolve the SIGNED-IN caller's own personal organization and delegate to the
// org-scoped functions above, so a UI surface never has to know or pass an
// organization id. Membership is still re-verified inside the delegated call
// (requireOrganization), so these add convenience, not privilege.
// ---------------------------------------------------------------------------

/**
 * Resolve the signed-in caller's personal organization id. Requires an active
 * user; fails closed with `AuthzError("organization_not_found")` if the caller
 * has no personal org (should never happen for a provisioned account).
 */
export async function resolveCallerPersonalOrganizationId(
  deps?: SubscriptionDeps,
): Promise<string> {
  const ctx = await requireUser(deps?.authz);
  const loadOrg = await resolveOrgLoader(deps?.resolvePersonalOrganizationId);
  const organizationId = await loadOrg(ctx.user.id);
  if (!organizationId) throw new AuthzError("organization_not_found");
  return organizationId;
}

/**
 * Self-service claim for the CALLER's own personal organization. Resolves the
 * caller's personal org, then delegates to {@link claimSelfServicePlan} (which
 * re-verifies membership and applies the enabled+published+self-service gate).
 */
export async function claimSelfServicePlanForCaller(
  planId: string,
  deps?: SubscriptionDeps,
): Promise<Subscription> {
  const organizationId = await resolveCallerPersonalOrganizationId(deps);
  return claimSelfServicePlan({ organizationId, planId }, deps);
}

/** List the CALLER's own personal-organization subscriptions. */
export async function listCallerSubscriptions(
  deps?: SubscriptionDeps,
): Promise<readonly Subscription[]> {
  const organizationId = await resolveCallerPersonalOrganizationId(deps);
  return listOrganizationSubscriptions(organizationId, deps);
}
