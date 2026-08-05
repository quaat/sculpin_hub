import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OutboxTransitionError, PostgresOutboxJobStore } from "./outbox.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION === "true";
const suite = enabled ? describe : describe.skip;
let seq = 400;
const uuid = () =>
  `00000000-0000-4000-8000-${(++seq).toString().padStart(12, "0")}`;

suite("outbox concurrency", () => {
  let pool: pg.Pool;
  let userId: string;
  let orgId: string;
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
    userId = uuid();
    orgId = uuid();
    await pool.query(
      "INSERT INTO users (id, normalized_email, display_name, locale) VALUES ($1,'outbox-owner@example.com','Owner','en')",
      [userId],
    );
    await pool.query(
      "INSERT INTO organizations (id, slug, type, personal_owner_user_id) VALUES ($1,'outbox-owner','personal',$2)",
      [orgId, userId],
    );
    await pool.query(
      "INSERT INTO organization_memberships (organization_id, user_id, role) VALUES ($1,$2,'owner')",
      [orgId, userId],
    );
  });
  afterAll(() => pool?.end());

  async function insertEvent(overrides: Record<string, unknown> = {}) {
    const id = uuid();
    await pool.query(
      `INSERT INTO outbox_events (id, organization_id, aggregate_type, aggregate_id, event_type, schema_version, payload, occurred_at, available_at, max_attempts, attempt_count, claimed_until, claim_owner, processed_at, terminal_error_code)
       VALUES ($1,$2,'organization',$2,'personal_organization.created',1,$3,now(),COALESCE($4, now()),COALESCE($5, 10),COALESCE($6, 0),$7,$8,$9,$10)`,
      [
        id,
        orgId,
        { organizationId: orgId, userId },
        overrides.availableAt ?? null,
        overrides.maxAttempts ?? null,
        overrides.attemptCount ?? null,
        overrides.claimedUntil ?? null,
        overrides.claimOwner ?? null,
        overrides.processedAt ?? null,
        overrides.terminalErrorCode ?? null,
      ],
    );
    return id;
  }

  it("prevents double-claiming and returns database claimedAt", async () => {
    const id = await insertEvent();
    const store = new PostgresOutboxJobStore(pool);
    const [a, b] = await Promise.all([
      store.claim(1, "worker-a", new Date("2000-01-01T00:00:00Z")),
      store.claim(1, "worker-b", new Date("2000-01-01T00:00:00Z")),
    ]);
    const claimed = [...a, ...b];
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.id).toBe(id);
    expect(claimed[0]?.attempt.claimedAt.getTime()).toBeGreaterThan(
      new Date("2020-01-01T00:00:00Z").getTime(),
    );
  });

  it("batch claims are disjoint", async () => {
    const ids = await Promise.all([
      insertEvent(),
      insertEvent(),
      insertEvent(),
      insertEvent(),
    ]);
    const store = new PostgresOutboxJobStore(pool);
    const [a, b] = await Promise.all([
      store.claim(2, "batch-a", new Date()),
      store.claim(2, "batch-b", new Date()),
    ]);
    const claimed = [...a, ...b].map((job) => job.id);
    expect(new Set(claimed).size).toBe(claimed.length);
    expect(claimed.sort()).toEqual(ids.sort());
  });

  it("keeps valid jobs claimable when a poison row is present", async () => {
    await pool.query(
      "INSERT INTO outbox_events (id, organization_id, aggregate_type, aggregate_id, event_type, schema_version, payload, occurred_at, available_at) VALUES ($1,$2,'organization',$2,'unsupported.event',2,'{}'::jsonb,now(),now())",
      [uuid(), orgId],
    );
    const valid = await insertEvent();
    const jobs = await new PostgresOutboxJobStore(pool).claim(
      10,
      "poison-worker",
      new Date(),
    );
    expect(jobs.map((job) => job.id)).toContain(valid);
    const terminal = await pool.query(
      "SELECT terminal_error_code FROM outbox_events WHERE terminal_error_code='payload_schema_invalid'",
    );
    expect(Number(terminal.rowCount)).toBeGreaterThan(0);
  });

  it("enforces lease, reclaim, owner, retries, and idempotent settlement", async () => {
    const active = await insertEvent({
      claimedUntil: new Date(Date.now() + 60_000),
      claimOwner: "active-owner",
    });
    await expect(
      new PostgresOutboxJobStore(pool).claim(10, "lease-worker", new Date()),
    ).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: active })]),
    );

    const expired = await insertEvent({
      claimedUntil: new Date(Date.now() - 60_000),
      claimOwner: "old-owner",
    });
    const [job] = await new PostgresOutboxJobStore(pool).claim(
      10,
      "new-owner",
      new Date(),
    );
    expect(job?.id).toBe(expired);
    await expect(
      new PostgresOutboxJobStore(pool).completeWithStatus(
        expired,
        "old-owner",
        { outcome: "completed" },
      ),
    ).rejects.toMatchObject(new OutboxTransitionError("ownership_conflict"));
    await expect(
      new PostgresOutboxJobStore(pool).completeWithStatus(
        expired,
        "new-owner",
        {
          outcome: "retryable_failure",
          reasonCode: "retry.later",
          retryAt: new Date(Date.now() - 1_000),
        },
      ),
    ).rejects.toThrow("retryAt");
    await expect(
      new PostgresOutboxJobStore(pool).completeWithStatus(
        expired,
        "new-owner",
        { outcome: "completed" },
      ),
    ).resolves.toBe("completed");
    await expect(
      new PostgresOutboxJobStore(pool).completeWithStatus(
        expired,
        "new-owner",
        { outcome: "completed" },
      ),
    ).resolves.toBe("already_settled");
    await expect(
      new PostgresOutboxJobStore(pool).completeWithStatus(
        expired,
        "new-owner",
        { outcome: "terminal_failure", reasonCode: "different.reason" },
      ),
    ).rejects.toMatchObject(new OutboxTransitionError("illegal_state"));
  });

  it("turns the final retry into attempts_exhausted and handles terminal idempotency", async () => {
    const id = await insertEvent({ maxAttempts: 1 });
    const [job] = await new PostgresOutboxJobStore(pool).claim(
      1,
      "terminal-owner",
      new Date(),
    );
    expect(job?.id).toBe(id);
    await expect(
      new PostgresOutboxJobStore(pool).completeWithStatus(
        id,
        "terminal-owner",
        {
          outcome: "retryable_failure",
          reasonCode: "retry",
          retryAt: new Date(Date.now() + 60_000),
        },
      ),
    ).resolves.toBe("terminal");
    const settled = await pool.query<{ version: number; terminalErrorCode: string }>(
      'SELECT version, terminal_error_code AS "terminalErrorCode" FROM outbox_events WHERE id=$1',
      [id],
    );
    expect(settled.rows[0]).toMatchObject({
      version: 3,
      terminalErrorCode: "attempts_exhausted",
    });
    await expect(
      new PostgresOutboxJobStore(pool).completeWithStatus(
        id,
        "terminal-owner",
        {
          outcome: "retryable_failure",
          reasonCode: "retry",
          retryAt: new Date(Date.now() + 60_000),
        },
      ),
    ).resolves.toBe("already_settled");
    const repeated = await pool.query<{ version: number; terminalErrorCode: string }>(
      'SELECT version, terminal_error_code AS "terminalErrorCode" FROM outbox_events WHERE id=$1',
      [id],
    );
    expect(repeated.rows[0]).toMatchObject({
      version: 3,
      terminalErrorCode: "attempts_exhausted",
    });
    await expect(
      new PostgresOutboxJobStore(pool).completeWithStatus(
        id,
        "terminal-owner",
        { outcome: "terminal_failure", reasonCode: "attempts_exhausted" },
      ),
    ).resolves.toBe("already_settled");
    await expect(
      new PostgresOutboxJobStore(pool).completeWithStatus(
        id,
        "terminal-owner",
        { outcome: "completed" },
      ),
    ).rejects.toMatchObject(new OutboxTransitionError("illegal_state"));
    await expect(
      new PostgresOutboxJobStore(pool).completeWithStatus(
        uuid(),
        "terminal-owner",
        { outcome: "completed" },
      ),
    ).rejects.toMatchObject(new OutboxTransitionError("missing"));
  });
});
