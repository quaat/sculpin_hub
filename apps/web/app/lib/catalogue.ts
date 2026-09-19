import { PostgresCatalogueRepository } from "@sculpin/db";
import type {
  CatalogueEntry,
  CatalogueEntryInput,
  CatalogueRepository,
  PublicModel,
} from "@sculpin/domain";
import { resolveAuthDependencies } from "./auth";
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
