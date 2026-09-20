import {
  DomainConflictError,
  validateCatalogueEntryInput,
  validateCatalogueEntryMetadataPatch,
  type CatalogueEntry,
  type CatalogueEntryInput,
  type CatalogueEntryMetadataPatch,
  type CatalogueEntryStatus,
  type CatalogueOfferingSummary,
  type CatalogueRepository,
  type PublicModel,
} from "@sculpin/domain";
import type { Pool } from "pg";

interface CatalogueRow {
  id: string;
  publicAlias: string;
  upstreamAgentId: string;
  displayName: string;
  description: string | null;
  accessInstructions: string | null;
  status: CatalogueEntryStatus;
  version: number;
}

const SELECT_COLUMNS =
  'id, public_alias AS "publicAlias", upstream_agent_id AS "upstreamAgentId", display_name AS "displayName", description, access_instructions AS "accessInstructions", status, version';

function mapRow(row: CatalogueRow): CatalogueEntry {
  return {
    id: row.id,
    publicAlias: row.publicAlias,
    upstreamAgentId: row.upstreamAgentId,
    displayName: row.displayName,
    ...(row.description !== null ? { description: row.description } : {}),
    ...(row.accessInstructions !== null
      ? { accessInstructions: row.accessInstructions }
      : {}),
    status: row.status,
    version: row.version,
  };
}

function mapCatalogueConflict(error: unknown): never {
  const pgError = error as { code?: string; constraint?: string };
  if (
    pgError.code === "23505" &&
    pgError.constraint === "catalogue_entries_public_alias_key"
  )
    throw new DomainConflictError("catalogue_alias_conflict");
  throw error;
}

export class PostgresCatalogueRepository implements CatalogueRepository {
  constructor(private readonly pool: Pool) {}

  async create(
    input: CatalogueEntryInput,
    adminUserId: string,
  ): Promise<CatalogueEntry> {
    validateCatalogueEntryInput(input);
    try {
      const result = await this.pool.query<CatalogueRow>(
        `INSERT INTO catalogue_entries (public_alias, upstream_agent_id, display_name, description, access_instructions, created_by_user_id, updated_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$6)
         RETURNING ${SELECT_COLUMNS}`,
        [
          input.publicAlias,
          input.upstreamAgentId,
          input.displayName,
          input.description ?? null,
          input.accessInstructions ?? null,
          adminUserId,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error("catalogue_insert_failed");
      return mapRow(row);
    } catch (error) {
      mapCatalogueConflict(error);
    }
  }

  async updateMetadata(
    id: string,
    patch: CatalogueEntryMetadataPatch,
    adminUserId: string,
  ): Promise<CatalogueEntry | undefined> {
    // Fail closed on any malformed field before touching the DB. This method
    // NEVER updates public_alias or upstream_agent_id — the alias↔agent mapping
    // is immutable once created.
    validateCatalogueEntryMetadataPatch(patch);
    const sets: string[] = [];
    const values: unknown[] = [id];
    const push = (column: string, value: unknown): void => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    if (patch.displayName !== undefined) push("display_name", patch.displayName);
    if (patch.description !== undefined) push("description", patch.description);
    if (patch.accessInstructions !== undefined)
      push("access_instructions", patch.accessInstructions);
    values.push(adminUserId);
    const actorParam = `$${values.length}`;
    if (sets.length === 0) sets.push("updated_at = now()");
    const result = await this.pool.query<CatalogueRow>(
      `UPDATE catalogue_entries
       SET ${sets.join(", ")}, updated_by_user_id = ${actorParam}, updated_at = now(), version = version + 1
       WHERE id = $1
       RETURNING ${SELECT_COLUMNS}`,
      values,
    );
    const row = result.rows[0];
    return row ? mapRow(row) : undefined;
  }

  private async setStatus(
    id: string,
    status: CatalogueEntryStatus,
    adminUserId: string,
  ): Promise<CatalogueEntry | undefined> {
    const result = await this.pool.query<CatalogueRow>(
      `UPDATE catalogue_entries
       SET status=$2, updated_by_user_id=$3, updated_at=now(), version=version+1
       WHERE id=$1
       RETURNING ${SELECT_COLUMNS}`,
      [id, status, adminUserId],
    );
    const row = result.rows[0];
    return row ? mapRow(row) : undefined;
  }

  publish(id: string, adminUserId: string): Promise<CatalogueEntry | undefined> {
    return this.setStatus(id, "published", adminUserId);
  }

  unpublish(
    id: string,
    adminUserId: string,
  ): Promise<CatalogueEntry | undefined> {
    return this.setStatus(id, "disabled", adminUserId);
  }

  async listAll(): Promise<readonly CatalogueEntry[]> {
    const result = await this.pool.query<CatalogueRow>(
      `SELECT ${SELECT_COLUMNS} FROM catalogue_entries ORDER BY public_alias`,
    );
    return result.rows.map(mapRow);
  }

  async listPublished(): Promise<readonly PublicModel[]> {
    // Deliberately does NOT select upstream_agent_id: the public projection can
    // never leak the upstream mapping.
    const result = await this.pool.query<{
      publicAlias: string;
      displayName: string;
      description: string | null;
      accessInstructions: string | null;
    }>(
      `SELECT public_alias AS "publicAlias", display_name AS "displayName", description, access_instructions AS "accessInstructions"
       FROM catalogue_entries WHERE status='published' ORDER BY public_alias`,
    );
    return result.rows.map((row) => ({
      id: row.publicAlias,
      displayName: row.displayName,
      ...(row.description !== null ? { description: row.description } : {}),
      ...(row.accessInstructions !== null
        ? { accessInstructions: row.accessInstructions }
        : {}),
    }));
  }

  /**
   * Proxy-facing projection of published models for the OpenAI `GET /v1/models`
   * surface. Selects the public alias, the INTERNAL catalogue-entry id (used
   * server-side by the data plane to intersect with the caller's authorized set
   * — NEVER sent to the client), and a creation timestamp — never
   * `upstream_agent_id` — so the data plane can never leak the upstream mapping.
   * `created` is unix seconds, as OpenAI clients expect.
   */
  async listPublishedModels(): Promise<
    readonly { id: string; catalogueEntryId: string; created: number }[]
  > {
    const result = await this.pool.query<{
      catalogueEntryId: string;
      publicAlias: string;
      createdAt: Date;
    }>(
      `SELECT id AS "catalogueEntryId", public_alias AS "publicAlias", created_at AS "createdAt"
       FROM catalogue_entries WHERE status='published' ORDER BY public_alias`,
    );
    return result.rows.map((row) => ({
      id: row.publicAlias,
      catalogueEntryId: row.catalogueEntryId,
      created: Math.floor(row.createdAt.getTime() / 1000),
    }));
  }

  async listSummariesByIds(
    ids: readonly string[],
  ): Promise<readonly CatalogueOfferingSummary[]> {
    if (ids.length === 0) return [];
    // Deliberately does NOT select upstream_agent_id: the summary is client-safe.
    // `= ANY($1::uuid[])` is fully parameterized (no interpolation); a malformed
    // id would surface as a cast error rather than being trusted.
    const result = await this.pool.query<{
      catalogueEntryId: string;
      publicAlias: string;
      displayName: string;
      status: CatalogueEntryStatus;
    }>(
      `SELECT id AS "catalogueEntryId", public_alias AS "publicAlias", display_name AS "displayName", status
       FROM catalogue_entries WHERE id = ANY($1::uuid[]) ORDER BY public_alias`,
      [[...ids]],
    );
    return result.rows.map((row) => ({
      catalogueEntryId: row.catalogueEntryId,
      publicAlias: row.publicAlias,
      displayName: row.displayName,
      status: row.status,
    }));
  }

  async resolvePublishedAlias(
    alias: string,
  ): Promise<{ catalogueEntryId: string; upstreamAgentId: string } | undefined> {
    const result = await this.pool.query<{
      catalogueEntryId: string;
      upstreamAgentId: string;
    }>(
      `SELECT id AS "catalogueEntryId", upstream_agent_id AS "upstreamAgentId"
       FROM catalogue_entries WHERE public_alias=$1 AND status='published'`,
      [alias],
    );
    const row = result.rows[0];
    return row
      ? {
          catalogueEntryId: row.catalogueEntryId,
          upstreamAgentId: row.upstreamAgentId,
        }
      : undefined;
  }
}
