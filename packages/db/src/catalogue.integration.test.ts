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
      "req-cat",
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
      "req-cat",
    );
    expect(await repository.resolvePublishedAlias("sculpin-pro")).toBeUndefined();
    const published = await repository.publish(entry.id, adminId, "req-cat");
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
      "req-cat",
    );
    await repository.publish(entry.id, adminId, "req-cat");
    expect(await repository.resolvePublishedAlias("sculpin-temp")).toEqual({
      catalogueEntryId: entry.id,
      upstreamAgentId: "internal-agent-temp",
    });
    const disabled = await repository.unpublish(entry.id, adminId, "req-cat");
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
      "req-cat",
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
      "req-cat",
    );
    expect(updated?.displayName).toBe("Renamed Guide");
    expect(updated?.description).toBeUndefined();
    expect(updated?.accessInstructions).toBe("New instructions.");
    expect(updated?.version).toBe(2);
    // The immutable mapping is unchanged by a metadata edit.
    expect(updated?.publicAlias).toBe("sculpin-guide");
    expect(updated?.upstreamAgentId).toBe("internal-agent-guide");

    // Published access instructions surface in the public projection.
    await repository.publish(entry.id, adminId, "req-cat");
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
      "req-cat",
    );
    expect(missing).toBeUndefined();
  });

  it("returns undefined when publishing a non-existent entry", async () => {
    const missing = await repository.publish(
      "00000000-0000-4000-8000-000000000000",
      adminId,
      "req-cat",
    );
    expect(missing).toBeUndefined();
  });

  it("summarizes entries by id (client-safe: never the upstream agent id) and returns [] for none", async () => {
    // `sculpin-pro` is published, `sculpin-fast` is a draft — both resolve as
    // summaries by id regardless of status (the caller filters by status).
    const proId = (await repository.resolvePublishedAlias("sculpin-pro"))
      ?.catalogueEntryId;
    expect(proId).toBeDefined();
    const all = await repository.listAll();
    const fast = all.find((e) => e.publicAlias === "sculpin-fast");
    expect(fast?.status).toBe("draft");

    const summaries = await repository.listSummariesByIds([proId!, fast!.id]);
    const byAlias = new Map(summaries.map((s) => [s.publicAlias, s]));
    expect(byAlias.get("sculpin-pro")?.status).toBe("published");
    expect(byAlias.get("sculpin-fast")?.status).toBe("draft");
    expect(byAlias.get("sculpin-pro")?.displayName).toBe("Sculpin Pro");
    // Client-safe: no upstream agent id is ever present on the summary.
    for (const summary of summaries) {
      expect(Object.keys(summary).sort()).toEqual([
        "catalogueEntryId",
        "displayName",
        "publicAlias",
        "status",
      ]);
    }
    expect(JSON.stringify(summaries)).not.toMatch(/internal-agent/);

    expect(await repository.listSummariesByIds([])).toEqual([]);
    expect(
      await repository.listSummariesByIds([
        "00000000-0000-4000-8000-000000000000",
      ]),
    ).toEqual([]);
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
        "req-cat-dup",
      ),
    ).rejects.toThrow(DomainConflictError);
  });
});
