import {
  validatePlanInput,
  validatePlanPatch,
  type Plan,
  type PlanInput,
  type PlanKind,
  type PlanPatch,
  type PlanRepository,
} from "@sculpin/domain";
import type { Pool } from "pg";

interface PlanRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  kind: PlanKind;
  enabled: boolean;
  published: boolean;
  selfServiceEligible: boolean;
  adminGrantable: boolean;
  durationDays: number | null;
  requestQuota: number;
  oneTimePerOrganization: boolean;
  version: number;
  catalogueEntryIds: string[] | null;
}

const SELECT_COLUMNS = `p.id,
  p.key,
  p.name,
  p.description,
  p.kind,
  p.enabled,
  p.published,
  p.self_service_eligible AS "selfServiceEligible",
  p.admin_grantable AS "adminGrantable",
  p.duration_days AS "durationDays",
  p.request_quota AS "requestQuota",
  p.one_time_per_organization AS "oneTimePerOrganization",
  p.version,
  COALESCE(
    (SELECT array_agg(pce.catalogue_entry_id::text ORDER BY pce.catalogue_entry_id)
       FROM plan_catalogue_entries pce
      WHERE pce.plan_id = p.id),
    ARRAY[]::text[]
  ) AS "catalogueEntryIds"`;

function mapRow(row: PlanRow): Plan {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    ...(row.description !== null ? { description: row.description } : {}),
    kind: row.kind,
    enabled: row.enabled,
    published: row.published,
    selfServiceEligible: row.selfServiceEligible,
    adminGrantable: row.adminGrantable,
    ...(row.durationDays !== null ? { durationDays: Number(row.durationDays) } : {}),
    requestQuota: Number(row.requestQuota),
    oneTimePerOrganization: row.oneTimePerOrganization,
    version: row.version,
    catalogueEntryIds: row.catalogueEntryIds ?? [],
  };
}

export class PostgresPlanRepository implements PlanRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: PlanInput, adminUserId: string): Promise<Plan> {
    validatePlanInput(input);
    const result = await this.pool.query<PlanRow>(
      `WITH inserted AS (
         INSERT INTO plans (
           key, name, description, kind, self_service_eligible, admin_grantable,
           duration_days, request_quota, one_time_per_organization,
           created_by, updated_by
         ) VALUES ($1,$2,$3,$4::plan_kind,$5,$6,$7,$8,$9,$10,$10)
         RETURNING *
       )
       SELECT ${SELECT_COLUMNS} FROM inserted p`,
      [
        input.key,
        input.name,
        input.description ?? null,
        input.kind,
        input.selfServiceEligible ?? false,
        input.adminGrantable ?? true,
        input.durationDays ?? null,
        input.requestQuota,
        // Free trials default to one-time-per-organization so a tenant cannot
        // re-claim a trial repeatedly; other kinds default to repeatable.
        input.oneTimePerOrganization ?? input.kind === "free_trial",
        adminUserId,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("plan_insert_failed");
    return mapRow(row);
  }

  async update(
    id: string,
    patch: PlanPatch,
    adminUserId: string,
  ): Promise<Plan | undefined> {
    // Fail closed on any out-of-range / malformed patch field before touching
    // the DB (name/description/duration/quota bounds + boolean policy flags).
    validatePlanPatch(patch);
    // Build a partial UPDATE that only touches provided fields. `durationDays`
    // accepts null to clear the window.
    const sets: string[] = [];
    const values: unknown[] = [id];
    const push = (column: string, value: unknown): void => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    if (patch.name !== undefined) push("name", patch.name);
    if (patch.description !== undefined)
      push("description", patch.description);
    if (patch.selfServiceEligible !== undefined)
      push("self_service_eligible", patch.selfServiceEligible);
    if (patch.adminGrantable !== undefined)
      push("admin_grantable", patch.adminGrantable);
    if (patch.durationDays !== undefined)
      push("duration_days", patch.durationDays);
    if (patch.requestQuota !== undefined)
      push("request_quota", patch.requestQuota);
    if (patch.oneTimePerOrganization !== undefined)
      push("one_time_per_organization", patch.oneTimePerOrganization);
    values.push(adminUserId);
    const actorParam = `$${values.length}`;
    if (sets.length === 0) {
      // Nothing to change other than the actor/version bookkeeping.
      sets.push("updated_at = now()");
    }
    const result = await this.pool.query<PlanRow>(
      `WITH updated AS (
         UPDATE plans
         SET ${sets.join(", ")}, updated_by = ${actorParam}, updated_at = now(), version = version + 1
         WHERE id = $1
         RETURNING *
       )
       SELECT ${SELECT_COLUMNS} FROM updated p`,
      values,
    );
    const row = result.rows[0];
    return row ? mapRow(row) : undefined;
  }

  private async setFlag(
    id: string,
    column: "enabled" | "published",
    value: boolean,
    adminUserId: string,
  ): Promise<Plan | undefined> {
    const result = await this.pool.query<PlanRow>(
      `WITH updated AS (
         UPDATE plans
         SET ${column} = $2, updated_by = $3, updated_at = now(), version = version + 1
         WHERE id = $1
         RETURNING *
       )
       SELECT ${SELECT_COLUMNS} FROM updated p`,
      [id, value, adminUserId],
    );
    const row = result.rows[0];
    return row ? mapRow(row) : undefined;
  }

  setEnabled(
    id: string,
    enabled: boolean,
    adminUserId: string,
  ): Promise<Plan | undefined> {
    return this.setFlag(id, "enabled", enabled, adminUserId);
  }

  setPublished(
    id: string,
    published: boolean,
    adminUserId: string,
  ): Promise<Plan | undefined> {
    return this.setFlag(id, "published", published, adminUserId);
  }

  async attachCatalogueEntry(
    planId: string,
    catalogueEntryId: string,
  ): Promise<Plan | undefined> {
    await this.pool.query(
      `INSERT INTO plan_catalogue_entries (plan_id, catalogue_entry_id)
       VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [planId, catalogueEntryId],
    );
    return this.findById(planId);
  }

  async detachCatalogueEntry(
    planId: string,
    catalogueEntryId: string,
  ): Promise<Plan | undefined> {
    await this.pool.query(
      "DELETE FROM plan_catalogue_entries WHERE plan_id = $1 AND catalogue_entry_id = $2",
      [planId, catalogueEntryId],
    );
    return this.findById(planId);
  }

  async listAll(): Promise<readonly Plan[]> {
    const result = await this.pool.query<PlanRow>(
      `SELECT ${SELECT_COLUMNS} FROM plans p ORDER BY p.key`,
    );
    return result.rows.map(mapRow);
  }

  async listSelfServicePublished(): Promise<readonly Plan[]> {
    const result = await this.pool.query<PlanRow>(
      `SELECT ${SELECT_COLUMNS} FROM plans p
       WHERE p.enabled = true AND p.published = true AND p.self_service_eligible = true
       ORDER BY p.key`,
    );
    return result.rows.map(mapRow);
  }

  async findById(id: string): Promise<Plan | undefined> {
    const result = await this.pool.query<PlanRow>(
      `SELECT ${SELECT_COLUMNS} FROM plans p WHERE p.id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? mapRow(row) : undefined;
  }

  async findByKey(key: string): Promise<Plan | undefined> {
    const result = await this.pool.query<PlanRow>(
      `SELECT ${SELECT_COLUMNS} FROM plans p WHERE p.key = $1`,
      [key],
    );
    const row = result.rows[0];
    return row ? mapRow(row) : undefined;
  }
}
