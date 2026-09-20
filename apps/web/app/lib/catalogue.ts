import { PostgresCatalogueRepository } from "@sculpin/db";
import {
  stableDiscoveredAgentIds,
  type CatalogueEntry,
  type CatalogueEntryInput,
  type CatalogueRepository,
  type DiscoveredAgent,
  type PublicModel,
} from "@sculpin/domain";
import { resolveAuthDependencies } from "./auth";
import { discoverSculpinAgents, type DiscoveryDeps } from "./discovery";
import { requireAdmin, type AuthzDeps } from "./session";

/**
 * M3 catalogue control-plane operations.
 *
 * Every mutating operation is gated by `requireAdmin`, which re-derives the
 * caller's platform role from the canonical `users` row (never the session), so
 * only a live, active admin can publish/unpublish. Reads of the PUBLIC model
 * list expose only aliases (never the upstream agent id). Dependencies are
 * injectable so unit tests run without a database.
 */

export interface CatalogueAdminDeps {
  readonly authz?: Partial<AuthzDeps>;
  readonly repository?: CatalogueRepository;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class CatalogueInputError extends Error {
  readonly reason = "invalid_catalogue_entry_id";
  constructor() {
    super("invalid_catalogue_entry_id");
    this.name = "CatalogueInputError";
  }
}

/**
 * Thrown when an admin tries to create a catalogue entry pointing at an upstream
 * agent that is NOT in the current discovery set (unknown or disappeared). Fails
 * closed so a public alias can never be minted onto a non-existent / replacement
 * upstream agent (CLAUDE.md rules 3-4; mission "fail closed if an agent
 * disappears"). Carries only a stable machine reason — never the agent id.
 */
export class UndiscoverableAgentError extends Error {
  readonly reason = "upstream_agent_not_discoverable";
  constructor() {
    super("upstream_agent_not_discoverable");
    this.name = "UndiscoverableAgentError";
  }
}

let defaultRepositoryPromise: Promise<CatalogueRepository> | undefined;

async function resolveRepository(
  repository?: CatalogueRepository,
): Promise<CatalogueRepository> {
  if (repository) return repository;
  defaultRepositoryPromise ??= (async () => {
    const { database } = resolveAuthDependencies();
    await database.ready();
    return new PostgresCatalogueRepository(database.pool);
  })();
  return defaultRepositoryPromise;
}

function assertEntryId(id: string): void {
  if (!uuidPattern.test(id)) throw new CatalogueInputError();
}

/**
 * Low-level admin primitive: create a catalogue entry from a hand-supplied
 * `upstreamAgentId`. This does NOT validate the id against the live Sculpin
 * discovery set — it is a deliberate admin-only escape hatch. The FAIL-CLOSED
 * path that binds a public alias only to a currently-discoverable STABLE
 * (uuid-form) upstream agent is `createCatalogueEntryFromDiscovered`; prefer it.
 * Admin surfaces (S6) route creation through the discovery-driven path.
 */
export async function createCatalogueEntry(
  input: CatalogueEntryInput,
  deps?: CatalogueAdminDeps,
): Promise<CatalogueEntry> {
  const ctx = await requireAdmin(deps?.authz);
  const repository = await resolveRepository(deps?.repository);
  return repository.create(input, ctx.user.id);
}

export async function publishCatalogueEntry(
  id: string,
  deps?: CatalogueAdminDeps,
): Promise<CatalogueEntry | undefined> {
  const ctx = await requireAdmin(deps?.authz);
  assertEntryId(id);
  const repository = await resolveRepository(deps?.repository);
  return repository.publish(id, ctx.user.id);
}

export async function unpublishCatalogueEntry(
  id: string,
  deps?: CatalogueAdminDeps,
): Promise<CatalogueEntry | undefined> {
  const ctx = await requireAdmin(deps?.authz);
  assertEntryId(id);
  const repository = await resolveRepository(deps?.repository);
  return repository.unpublish(id, ctx.user.id);
}

export async function listCatalogueForAdmin(
  deps?: CatalogueAdminDeps,
): Promise<readonly CatalogueEntry[]> {
  await requireAdmin(deps?.authz);
  const repository = await resolveRepository(deps?.repository);
  return repository.listAll();
}

/**
 * Public model list (aliases only). Not admin-gated — it exposes nothing beyond
 * what a client may send as the `model` id. The upstream agent id is never
 * included by construction (see `CatalogueRepository.listPublished`).
 */
export async function listPublicModels(
  deps?: Pick<CatalogueAdminDeps, "repository">,
): Promise<readonly PublicModel[]> {
  const repository = await resolveRepository(deps?.repository);
  return repository.listPublished();
}

// ---------------------------------------------------------------------------
// S5 — discovery-driven catalogue admin
//
// These admin-gated operations bridge server-side Sculpin discovery
// (`./discovery`) to the catalogue. They uphold the mission invariant that a
// public alias must map ONLY to a real, currently-discoverable STABLE upstream
// agent id, and that a disappeared agent is surfaced (fail closed) rather than
// silently re-pointed. The `upstreamAgentId` is admin-only: it appears only on
// these admin surfaces and never in the public `toPublicModel` / `listPublished`
// projection (unchanged).
// ---------------------------------------------------------------------------

export interface DiscoveryDrivenDeps extends CatalogueAdminDeps {
  /** Overrides discovery (tests inject a fake fetch via `discovery.fetchImpl`). */
  readonly discovery?: DiscoveryDeps;
  /**
   * Optional pre-fetched discovery set (avoids a second upstream round-trip when
   * the caller already discovered). When provided it is used AS-IS; otherwise
   * `discoverSculpinAgents` is called (admin-gated internally).
   */
  readonly discoveredAgents?: readonly DiscoveredAgent[];
}

export interface CreateFromDiscoveredInput {
  readonly publicAlias: string;
  readonly displayName: string;
  readonly description?: string;
  /**
   * The STABLE discovered agent id (a UUID form) to bind this alias to. Validated
   * against the live discovery set before creation.
   */
  readonly upstreamAgentId: string;
}

async function resolveDiscovered(
  deps?: DiscoveryDrivenDeps,
): Promise<readonly DiscoveredAgent[]> {
  if (deps?.discoveredAgents) return deps.discoveredAgents;
  return discoverSculpinAgents(deps?.discovery);
}

/**
 * Admin-gated: create a catalogue entry FROM a discovered agent. The admin
 * chooses the public alias / display metadata; `upstreamAgentId` MUST be a
 * currently-discoverable STABLE (uuid-form) agent id. If it is not in the live
 * discovery set (unknown or disappeared) this FAILS CLOSED with
 * `UndiscoverableAgentError` and never creates the entry — a public alias can
 * never resolve to a non-existent / replacement upstream agent.
 */
export async function createCatalogueEntryFromDiscovered(
  input: CreateFromDiscoveredInput,
  deps?: DiscoveryDrivenDeps,
): Promise<CatalogueEntry> {
  const ctx = await requireAdmin(deps?.authz);
  // Discovery (also admin-gated) is fetched under the same admin identity; the
  // credential boundary lives entirely in `./discovery`.
  const discovered = await resolveDiscovered(deps);
  const stableIds = stableDiscoveredAgentIds(discovered);
  if (!stableIds.has(input.upstreamAgentId)) throw new UndiscoverableAgentError();
  const repository = await resolveRepository(deps?.repository);
  const entryInput: CatalogueEntryInput = {
    publicAlias: input.publicAlias,
    upstreamAgentId: input.upstreamAgentId,
    displayName: input.displayName,
    ...(input.description !== undefined ? { description: input.description } : {}),
  };
  return repository.create(entryInput, ctx.user.id);
}

/**
 * A published (or otherwise stored) catalogue entry whose `upstreamAgentId` is no
 * longer present in the current discovery set — a candidate to disable. Admin-only
 * (carries the upstream agent id, which the public projection never exposes).
 */
export interface CatalogueDriftEntry {
  readonly id: string;
  readonly publicAlias: string;
  readonly upstreamAgentId: string;
  readonly status: CatalogueEntry["status"];
}

/**
 * Admin-gated drift/health check: compare the stored catalogue against the live
 * discovery set and REPORT which entries reference an `upstreamAgentId` that has
 * disappeared upstream. This does NOT auto-disable anything (S6 UI acts on it);
 * it only surfaces candidates so an admin (or a later job) can fail closed.
 *
 * Membership is checked against the STABLE (uuid-form) discovered ids — the only
 * ids the catalogue should ever store (see create-from-discovered). An entry
 * whose stored id is not a discoverable stable id is therefore flagged.
 */
export async function detectCatalogueDrift(
  deps?: DiscoveryDrivenDeps,
): Promise<readonly CatalogueDriftEntry[]> {
  await requireAdmin(deps?.authz);
  const discovered = await resolveDiscovered(deps);
  const stableIds = stableDiscoveredAgentIds(discovered);
  const repository = await resolveRepository(deps?.repository);
  const entries = await repository.listAll();
  return entries
    .filter((entry) => !stableIds.has(entry.upstreamAgentId))
    .map((entry) => ({
      id: entry.id,
      publicAlias: entry.publicAlias,
      upstreamAgentId: entry.upstreamAgentId,
      status: entry.status,
    }));
}
