import type {
  ClaimedJob,
  JobPayload,
  JobResult,
  JobStore,
} from "@sculpin/jobs";
import type { Pool, PoolClient } from "pg";

export type OutboxCompletionStatus =
  | "completed"
  | "retry_scheduled"
  | "terminal"
  | "already_settled";

const workerPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const reasonPattern = /^[a-z][a-z0-9_.:-]{1,79}$/;
const secretKeyPattern =
  /(authorization|cookie|token|secret|password|passphrase|apikey|clientsecret|databaseurl|connectionstring|credential|session)/i;

type PersonalOrganizationCreatedV1 = Readonly<{
  organizationId: string;
  userId: string;
}>;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function assertNoSensitiveKeys(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoSensitiveKeys(item);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (secretKeyPattern.test(normalizeKey(key)))
      throw new Error("outbox_payload_sensitive");
    assertNoSensitiveKeys(nested);
  }
}

export function validateOutboxPayload(
  eventType: string,
  schemaVersion: number,
  value: unknown,
): JobPayload {
  assertNoSensitiveKeys(value);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("outbox_payload_invalid");
  if (eventType !== "personal_organization.created" || schemaVersion !== 1)
    throw new Error("outbox_payload_schema_unsupported");
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "organizationId,userId")
    throw new Error("outbox_payload_unknown_fields");
  const payload = value as PersonalOrganizationCreatedV1;
  if (
    !uuidPattern.test(payload.organizationId) ||
    !uuidPattern.test(payload.userId)
  )
    throw new Error("outbox_payload_invalid");
  return payload;
}

async function terminalizePoison(
  client: PoolClient,
  id: string,
): Promise<void> {
  await client.query(
    "UPDATE outbox_events SET terminal_error_code='payload_schema_invalid', claim_owner=NULL, claimed_until=NULL, version=version+1 WHERE id=$1 AND processed_at IS NULL AND terminal_error_code IS NULL",
    [id],
  );
}

export class OutboxTransitionError extends Error {
  override readonly name = "OutboxTransitionError";
  constructor(
    readonly code: "missing" | "ownership_conflict" | "illegal_state",
  ) {
    super(code);
  }
}

export class PostgresOutboxJobStore implements JobStore {
  constructor(
    private readonly pool: Pool,
    private readonly leaseMs = 30_000,
  ) {
    if (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 3_600_000)
      throw new RangeError("leaseMs must be 1s-1h");
  }

  async claim(
    batchSize: number,
    workerId: string,
    now: Date,
  ): Promise<readonly ClaimedJob[]> {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100)
      throw new RangeError("batchSize must be between 1 and 100");
    if (!workerPattern.test(workerId)) throw new Error("workerId is invalid");
    if (!(now instanceof Date) || Number.isNaN(now.getTime()))
      throw new Error("now must be a valid Date");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const candidates = await client.query<{
        id: string;
        type: string;
        schemaVersion: number;
        payload: unknown;
      }>(
        `SELECT id, event_type AS type, schema_version AS "schemaVersion", payload
         FROM outbox_events
         WHERE processed_at IS NULL AND terminal_error_code IS NULL
           AND available_at <= now() AND (claimed_until IS NULL OR claimed_until <= now())
           AND attempt_count < max_attempts
         ORDER BY available_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT $1`,
        [batchSize],
      );
      const validIds: string[] = [];
      const payloads = new Map<string, JobPayload>();
      for (const row of candidates.rows) {
        try {
          payloads.set(
            row.id,
            validateOutboxPayload(row.type, row.schemaVersion, row.payload),
          );
          validIds.push(row.id);
        } catch {
          await terminalizePoison(client, row.id);
        }
      }
      if (validIds.length === 0) {
        await client.query("COMMIT");
        return [];
      }
      const claimed = await client.query<{
        id: string;
        type: string;
        schemaVersion: number;
        attempt: number;
        maxAttempts: number;
      }>(
        `UPDATE outbox_events event
         SET claim_owner=$2, claimed_until=now()+($3::text || ' milliseconds')::interval,
             attempt_count=event.attempt_count+1, version=event.version+1
         WHERE event.id = ANY($1::uuid[])
         RETURNING event.id, event.event_type AS type, event.schema_version AS "schemaVersion", event.attempt_count AS attempt, event.max_attempts AS "maxAttempts"`,
        [validIds, workerId, this.leaseMs],
      );
      await client.query("COMMIT");
      return claimed.rows.map((row) => ({
        id: row.id,
        type: row.type,
        payload:
          payloads.get(row.id) ??
          validateOutboxPayload(row.type, row.schemaVersion, {}),
        attempt: {
          attempt: row.attempt,
          maxAttempts: row.maxAttempts,
          claimedAt: now,
          claimedBy: workerId,
        },
      }));
    } catch (error) {
      await client.query("ROLLBACK").catch((rollbackError: unknown) => {
        throw new AggregateError(
          [error, rollbackError],
          "outbox claim rollback failed",
        );
      });
      throw error;
    } finally {
      client.release();
    }
  }

  async complete(
    jobId: string,
    workerId: string,
    result: JobResult,
  ): Promise<void> {
    await this.completeWithStatus(jobId, workerId, result);
  }

  async completeWithStatus(
    jobId: string,
    workerId: string,
    result: JobResult,
  ): Promise<OutboxCompletionStatus> {
    if (!uuidPattern.test(jobId)) throw new Error("jobId is invalid");
    if (!workerPattern.test(workerId)) throw new Error("workerId is invalid");
    if ("reasonCode" in result && !reasonPattern.test(result.reasonCode))
      throw new Error("reasonCode is invalid");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query<{
        claimOwner: string | null;
        processedAt: Date | null;
        terminalErrorCode: string | null;
        attemptCount: number;
        maxAttempts: number;
      }>(
        'SELECT claim_owner AS "claimOwner", processed_at AS "processedAt", terminal_error_code AS "terminalErrorCode", attempt_count AS "attemptCount", max_attempts AS "maxAttempts" FROM outbox_events WHERE id=$1 FOR UPDATE',
        [jobId],
      );
      const row = locked.rows[0];
      if (!row) throw new OutboxTransitionError("missing");
      if (row.processedAt || row.terminalErrorCode) {
        await client.query("COMMIT");
        return "already_settled";
      }
      if (row.claimOwner !== workerId)
        throw new OutboxTransitionError(
          row.claimOwner ? "ownership_conflict" : "illegal_state",
        );
      if (result.outcome === "completed") {
        await client.query(
          "UPDATE outbox_events SET processed_at=now(), claim_owner=NULL, claimed_until=NULL, version=version+1 WHERE id=$1",
          [jobId],
        );
        await client.query("COMMIT");
        return "completed";
      }
      if (
        result.outcome === "terminal_failure" ||
        row.attemptCount >= row.maxAttempts
      ) {
        const code =
          result.outcome === "terminal_failure"
            ? result.reasonCode
            : "attempts_exhausted";
        await client.query(
          "UPDATE outbox_events SET terminal_error_code=$2, claim_owner=NULL, claimed_until=NULL, version=version+1 WHERE id=$1",
          [jobId, code],
        );
        await client.query("COMMIT");
        return "terminal";
      }
      if (
        !(result.retryAt instanceof Date) ||
        Number.isNaN(result.retryAt.getTime())
      )
        throw new Error("retryAt must be a valid Date");
      await client.query(
        "UPDATE outbox_events SET available_at=$2, claim_owner=NULL, claimed_until=NULL, version=version+1 WHERE id=$1",
        [jobId, result.retryAt],
      );
      await client.query("COMMIT");
      return "retry_scheduled";
    } catch (error) {
      await client.query("ROLLBACK").catch((rollbackError: unknown) => {
        throw new AggregateError(
          [error, rollbackError],
          "outbox completion rollback failed",
        );
      });
      throw error;
    } finally {
      client.release();
    }
  }
}
