import { PostgresCatalogueRepository } from "@sculpin/db";
import type {
  CatalogueOfferingSummary,
  CatalogueRepository,
  SubscriptionRepository,
} from "@sculpin/domain";
import { resolveAuthDependencies } from "./auth";
import { getOrganizationEntitlement } from "./entitlement";
import type { AuthzDeps } from "./session";
import { resolveCallerPersonalOrganizationId } from "./subscription";

/**
 * PAT scope resolution (web-control-plane, CLAUDE.md rules 1-2 / D-015).
 *
 * A PAT scope narrows a token to a subset of the caller's offerings. The set a
 * caller may pick from is the intersection of the PUBLISHED catalogue and the
 * caller's ACTIVE entitlement (`entitledCatalogueEntryIds`). Both are re-resolved
 * SERVER-SIDE on every mint from the canonical rows — the browser only ever names
 * public aliases, never internal ids, and can never forge a scope for an offering
 * it is not entitled to. Dependencies are injectable so unit tests run without a
 * database.
 */

export interface PatScopeDeps {
  readonly authz?: Partial<AuthzDeps>;
  readonly catalogue?: CatalogueRepository;
  readonly subscriptions?: SubscriptionRepository;
  readonly resolvePersonalOrganizationId?: (
    userId: string,
  ) => Promise<string | null>;
  readonly now?: () => Date;
}

let defaultCataloguePromise: Promise<CatalogueRepository> | undefined;

async function resolveCatalogue(
  repository?: CatalogueRepository,
): Promise<CatalogueRepository> {
  if (repository) return repository;
  defaultCataloguePromise ??= (async () => {
    const { database } = resolveAuthDependencies();
    await database.ready();
    return new PostgresCatalogueRepository(database.pool);
  })();
  return defaultCataloguePromise;
}

/**
 * The offerings the signed-in caller may scope a new PAT to: PUBLISHED catalogue
 * entries the caller is currently ENTITLED to (union of active subscriptions).
 * Returns client-safe summaries (no upstream agent id) sorted by public alias.
 * The `catalogueEntryId` on each item is used server-side to translate an alias
 * selection into the immutable scope id; the browser is only shown alias + name.
 */
export async function resolveScopableOfferings(
  deps?: PatScopeDeps,
): Promise<readonly CatalogueOfferingSummary[]> {
  const organizationId = await resolveCallerPersonalOrganizationId({
    ...(deps?.authz ? { authz: deps.authz } : {}),
    ...(deps?.subscriptions
      ? { subscriptionRepository: deps.subscriptions }
      : {}),
    ...(deps?.resolvePersonalOrganizationId
      ? { resolvePersonalOrganizationId: deps.resolvePersonalOrganizationId }
      : {}),
  });
  const { entitlement } = await getOrganizationEntitlement(organizationId, {
    ...(deps?.authz ? { authz: deps.authz } : {}),
    ...(deps?.subscriptions ? { repository: deps.subscriptions } : {}),
    ...(deps?.now ? { now: deps.now } : {}),
  });
  const catalogue = await resolveCatalogue(deps?.catalogue);
  const summaries = await catalogue.listSummariesByIds(
    entitlement.entitledCatalogueEntryIds,
  );
  return summaries.filter((summary) => summary.status === "published");
}

/**
 * Label a set of stored PAT scope ids (catalogue-entry uuids) with client-safe
 * "Display name (alias)" strings for the token list. Unlike
 * {@link resolveScopableOfferings} this does NOT filter by status/entitlement —
 * a token may retain a scope whose offering was later unpublished, and the owner
 * should still see what it was scoped to. Ids that no longer resolve are omitted
 * (the caller renders a neutral fallback).
 */
export async function resolveScopeLabels(
  scopeIds: readonly string[],
  deps?: Pick<PatScopeDeps, "catalogue">,
): Promise<ReadonlyMap<string, string>> {
  if (scopeIds.length === 0) return new Map();
  const catalogue = await resolveCatalogue(deps?.catalogue);
  const summaries = await catalogue.listSummariesByIds(scopeIds);
  return new Map(
    summaries.map((summary) => [
      summary.catalogueEntryId,
      `${summary.displayName} (${summary.publicAlias})`,
    ]),
  );
}
