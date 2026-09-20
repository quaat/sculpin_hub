import { DomainConflictError } from "@sculpin/domain";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresCatalogueRepository } from "./catalogue.js";
import { PostgresPersonalTenantTransaction } from "./tenant.js";

/**
 * M3 catalogue invariants against a real (ephemeral) PostgreSQL:
 *  - resolution is fail-closed: a draft/disabled alias never resolves; only a
 *    `published` alias maps to its upstream agent id;
 *  - the PUBLIC projection (`listPublished`) never carries the upstream agent id;
 *  - the unique public alias is enforced (mapped to a domain conflict).
 */
const enabled = process.env.RUN_DATABASE_INTEGRATION === "true";
const suite = enabled ? describe : describe.skip;

suite("catalogue repository", () => {
  let pool: pg.Pool;
  let repository: PostgresCatalogueRepository;
  let adminId: string;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
    repository = new PostgresCatalogueRepository(pool);
    const tenant = new PostgresPersonalTenantTransaction(pool);
    const result = await tenant.create({
      normalizedEmail: "catalogue-admin@example.com",
      displayName: "Catalogue Admin",
      locale: "en",
      organizationSlug: "catalogue-admin-org",
      requestId: "catalogue-admin",
    });
    adminId = result.userId;
  });
  afterAll(() => pool?.end());

  it("creates a draft entry that does not resolve (fail closed)", async () => {
    const entry = await repository.create(
      {
        publicAlias: "sculpin-fast",
        upstreamAgentId: "internal-agent-fast",
        displayName: "Sculpin Fast",
        description: "A fast agent.",
      },
      adminId,
    );
    expect(entry.status).toBe("draft");
    expect(entry.publicAlias).toBe("sculpin-fast");
    expect(await repository.resolvePublishedAlias("sculpin-fast")).toBeUndefined();
    const { rows } = await pool.query<{
      created_by_user_id: string;
      updated_by_user_id: string;
    }>(
      "SELECT created_by_user_id, updated_by_user_id FROM catalogue_entries WHERE id=$1",
      [entry.id],
    );
    expect(rows[0]?.created_by_user_id).toBe(adminId);
    expect(rows[0]?.updated_by_user_id).toBe(adminId);
  });

  it("resolves the upstream agent id only once published", async () => {
    const entry = await repository.create(
      {
        publicAlias: "sculpin-pro",
        upstreamAgentId: "internal-agent-pro",
        displayName: "Sculpin Pro",
      },
      adminId,
    );
    expect(await repository.resolvePublishedAlias("sculpin-pro")).toBeUndefined();
    const published = await repository.publish(entry.id, adminId);
    expect(published?.status).toBe("published");
    expect(published?.version).toBe(2);
    expect(await repository.resolvePublishedAlias("sculpin-pro")).toEqual({
      catalogueEntryId: entry.id,
      upstreamAgentId: "internal-agent-pro",
    });
  });

  it("stops resolving after unpublish", async () => {
    const entry = await repository.create(
      {
        publicAlias: "sculpin-temp",
        upstreamAgentId: "internal-agent-temp",
        displayName: "Sculpin Temp",
      },
      adminId,
    );
    await repository.publish(entry.id, adminId);
    expect(await repository.resolvePublishedAlias("sculpin-temp")).toEqual({
      catalogueEntryId: entry.id,
      upstreamAgentId: "internal-agent-temp",
    });
    const disabled = await repository.unpublish(entry.id, adminId);
    expect(disabled?.status).toBe("disabled");
    expect(await repository.resolvePublishedAlias("sculpin-temp")).toBeUndefined();
  });

  it("never exposes the upstream agent id in the public projection", async () => {
    const models = await repository.listPublished();
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      expect(Object.keys(model).sort()).not.toContain("upstreamAgentId");
    }
    const serialized = JSON.stringify(models);
    expect(serialized).not.toMatch(/internal-agent/);
    // Only published aliases appear (draft `sculpin-fast` and disabled
    // `sculpin-temp` are excluded).
    const ids = models.map((m) => m.id);
    expect(ids).toContain("sculpin-pro");
    expect(ids).not.toContain("sculpin-fast");
    expect(ids).not.toContain("sculpin-temp");
  });

  it("exposes only published aliases with a created timestamp to the proxy, never the upstream id", async () => {
    const models = await repository.listPublishedModels();
    const ids = models.map((m) => m.id);
    expect(ids).toContain("sculpin-pro");
    expect(ids).not.toContain("sculpin-fast");
    expect(ids).not.toContain("sculpin-temp");
    for (const model of models) {
      expect(Object.keys(model).sort()).toEqual([
        "catalogueEntryId",
        "created",
        "id",
      ]);
      expect(Number.isInteger(model.created)).toBe(true);
      expect(model.created).toBeGreaterThan(0);
      expect(model.catalogueEntryId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    }
    expect(JSON.stringify(models)).not.toMatch(/internal-agent/);
  });

  it("round-trips access instructions and edits them via updateMetadata, never touching the alias/agent mapping", async () => {
    const entry = await repository.create(
      {
        publicAlias: "sculpin-guide",
        upstreamAgentId: "internal-agent-guide",
        displayName: "Sculpin Guide",
        description: "A guided agent.",
        accessInstructions: "Step 1\nStep 2",
      },
      adminId,
    );
    expect(entry.accessInstructions).toBe("Step 1\nStep 2");

    const updated = await repository.updateMetadata(
      entry.id,
      {
        displayName: "Renamed Guide",
        description: null,
        accessInstructions: "New instructions.",
      },
      adminId,
    );
    expect(updated?.displayName).toBe("Renamed Guide");
    expect(updated?.description).toBeUndefined();
    expect(updated?.accessInstructions).toBe("New instructions.");
    expect(updated?.version).toBe(2);
    // The immutable mapping is unchanged by a metadata edit.
    expect(updated?.publicAlias).toBe("sculpin-guide");
    expect(updated?.upstreamAgentId).toBe("internal-agent-guide");

    // Published access instructions surface in the public projection.
    await repository.publish(entry.id, adminId);
    const published = (await repository.listPublished()).find(
      (m) => m.id === "sculpin-guide",
    );
    expect(published?.accessInstructions).toBe("New instructions.");
  });

  it("returns undefined when updating metadata of a non-existent entry", async () => {
    const missing = await repository.updateMetadata(
      "00000000-0000-4000-8000-000000000000",
      { displayName: "Nope" },
      adminId,
    );
    expect(missing).toBeUndefined();
  });

  it("returns undefined when publishing a non-existent entry", async () => {
    const missing = await repository.publish(
      "00000000-0000-4000-8000-000000000000",
      adminId,
    );
    expect(missing).toBeUndefined();
  });

  it("rejects a duplicate public alias with a domain conflict", async () => {
    await expect(
      repository.create(
        {
          publicAlias: "sculpin-fast",
          upstreamAgentId: "another-agent",
          displayName: "Duplicate",
        },
        adminId,
      ),
    ).rejects.toThrow(DomainConflictError);
  });
});
