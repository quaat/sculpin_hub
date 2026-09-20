import { PostgresPlanRepository } from "@sculpin/db";
import type {
  Plan,
  PlanInput,
  PlanPatch,
  PlanRepository,
} from "@sculpin/domain";
import { resolveAuthDependencies } from "./auth";
import { requireAdmin, type AuthzDeps } from "./session";

/**
 * S6 plan administration — thin, admin-gated wrappers over `PlanRepository`.
 *
 * Every operation is gated by `requireAdmin`, which re-derives the caller's
 * platform role from the canonical `users` row (never the session), so only a
 * live, active admin can create / edit / (un)publish plans or manage their
 * catalogue-entry mapping. Plan-input validation lives in
 * `PostgresPlanRepository.create` (via `validatePlanInput`), so `createPlan`
 * does NOT re-validate. Ids are shape-checked as uuids before any repository
 * access (fail closed on bad input). Dependencies are injectable so unit tests
 * run without a database.
 */

export interface PlanAdminDeps {
  readonly authz?: Partial<AuthzDeps>;
  readonly repository?: PlanRepository;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Thrown for a malformed plan / catalogue-entry id before repository access. */
export class PlanAdminInputError extends Error {
  readonly reason = "invalid_plan_id";
  constructor() {
    super("invalid_plan_id");
    this.name = "PlanAdminInputError";
  }
}

let defaultRepositoryPromise: Promise<PlanRepository> | undefined;

async function resolveRepository(
  repository?: PlanRepository,
): Promise<PlanRepository> {
  if (repository) return repository;
  defaultRepositoryPromise ??= (async () => {
    const { database } = resolveAuthDependencies();
    await database.ready();
    return new PostgresPlanRepository(database.pool);
  })();
  return defaultRepositoryPromise;
}

function assertPlanId(id: string): void {
  if (!uuidPattern.test(id)) throw new PlanAdminInputError();
}

export async function createPlan(
  input: PlanInput,
  deps?: PlanAdminDeps,
): Promise<Plan> {
  const ctx = await requireAdmin(deps?.authz);
  const repository = await resolveRepository(deps?.repository);
  // `PostgresPlanRepository.create` calls `validatePlanInput`; not re-validated.
  return repository.create(input, ctx.user.id);
}

export async function updatePlan(
  id: string,
  patch: PlanPatch,
  deps?: PlanAdminDeps,
): Promise<Plan | undefined> {
  const ctx = await requireAdmin(deps?.authz);
  assertPlanId(id);
  const repository = await resolveRepository(deps?.repository);
  return repository.update(id, patch, ctx.user.id);
}

export async function setPlanEnabled(
  id: string,
  enabled: boolean,
  deps?: PlanAdminDeps,
): Promise<Plan | undefined> {
  const ctx = await requireAdmin(deps?.authz);
  assertPlanId(id);
  const repository = await resolveRepository(deps?.repository);
  return repository.setEnabled(id, enabled, ctx.user.id);
}

export async function setPlanPublished(
  id: string,
  published: boolean,
  deps?: PlanAdminDeps,
): Promise<Plan | undefined> {
  const ctx = await requireAdmin(deps?.authz);
  assertPlanId(id);
  const repository = await resolveRepository(deps?.repository);
  return repository.setPublished(id, published, ctx.user.id);
}

export async function attachPlanCatalogueEntry(
  planId: string,
  catalogueEntryId: string,
  deps?: PlanAdminDeps,
): Promise<Plan | undefined> {
  await requireAdmin(deps?.authz);
  assertPlanId(planId);
  assertPlanId(catalogueEntryId);
  const repository = await resolveRepository(deps?.repository);
  return repository.attachCatalogueEntry(planId, catalogueEntryId);
}

export async function detachPlanCatalogueEntry(
  planId: string,
  catalogueEntryId: string,
  deps?: PlanAdminDeps,
): Promise<Plan | undefined> {
  await requireAdmin(deps?.authz);
  assertPlanId(planId);
  assertPlanId(catalogueEntryId);
  const repository = await resolveRepository(deps?.repository);
  return repository.detachCatalogueEntry(planId, catalogueEntryId);
}

export async function listPlansForAdmin(
  deps?: PlanAdminDeps,
): Promise<readonly Plan[]> {
  await requireAdmin(deps?.authz);
  const repository = await resolveRepository(deps?.repository);
  return repository.listAll();
}

export async function getPlanForAdmin(
  id: string,
  deps?: PlanAdminDeps,
): Promise<Plan | undefined> {
  await requireAdmin(deps?.authz);
  assertPlanId(id);
  const repository = await resolveRepository(deps?.repository);
  return repository.findById(id);
}
