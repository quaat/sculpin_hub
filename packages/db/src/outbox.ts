import type {
  ClaimedJob,
  JobPayload,
  JobResult,
  JobStore,
} from "@sculpin/jobs";
import type { Pool } from "pg";

const sensitiveKeys = new Set([
  "accessToken",
  "refreshToken",
  "password",
  "authorization",
  "cookie",
  "clientSecret",
]);
function validatePayload(value: unknown): JobPayload {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("outbox_payload_invalid");
  for (const key of Object.keys(value))
    if (sensitiveKeys.has(key)) throw new Error("outbox_payload_sensitive");
  return value as JobPayload;
}

export class PostgresOutboxJobStore implements JobStore {
  constructor(
    private readonly pool: Pool,
    private readonly leaseMs = 30_000,
  ) {}

  async claim(
    batchSize: number,
    workerId: string,
    now: Date,
  ): Promise<readonly ClaimedJob[]> {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100)
      throw new RangeError("batchSize must be between 1 and 100");
    if (!workerId) throw new Error("workerId is required");
    const claimedUntil = new Date(now.getTime() + this.leaseMs);
    const result = await this.pool.query<{
      id: string;
      type: string;
      payload: unknown;
      attempt: number;
      maxAttempts: number;
    }>(
      `
      WITH candidates AS (
        SELECT id FROM outbox_events
        WHERE processed_at IS NULL AND terminal_error_code IS NULL
          AND available_at <= $1 AND (claimed_until IS NULL OR claimed_until <= $1)
          AND attempt_count < max_attempts
        ORDER BY available_at, id FOR UPDATE SKIP LOCKED LIMIT $2
      )
      UPDATE outbox_events event SET claim_owner=$3, claimed_until=$4,
        attempt_count=event.attempt_count+1, version=event.version+1
      FROM candidates WHERE event.id=candidates.id
      RETURNING event.id, event.event_type AS type, event.payload,
        event.attempt_count AS attempt, event.max_attempts AS "maxAttempts"`,
      [now, batchSize, workerId, claimedUntil],
    );
    return result.rows.map((row) => ({
      id: row.id,
      type: row.type,
      payload: validatePayload(row.payload),
      attempt: {
        attempt: row.attempt,
        maxAttempts: row.maxAttempts,
        claimedAt: now,
        claimedBy: workerId,
      },
    }));
  }

  async complete(
    jobId: string,
    workerId: string,
    result: JobResult,
  ): Promise<void> {
    const values =
      result.outcome === "completed"
        ? [jobId, workerId]
        : [
            jobId,
            workerId,
            result.reasonCode,
            result.outcome === "retryable_failure" ? result.retryAt : null,
          ];
    const sql =
      result.outcome === "completed"
        ? "UPDATE outbox_events SET processed_at=now(), claim_owner=NULL, claimed_until=NULL, version=version+1 WHERE id=$1 AND claim_owner=$2 AND processed_at IS NULL"
        : result.outcome === "retryable_failure"
          ? "UPDATE outbox_events SET available_at=$4, claim_owner=NULL, claimed_until=NULL, version=version+1 WHERE id=$1 AND claim_owner=$2 AND processed_at IS NULL AND terminal_error_code IS NULL"
          : "UPDATE outbox_events SET terminal_error_code=$3, claim_owner=NULL, claimed_until=NULL, version=version+1 WHERE id=$1 AND claim_owner=$2 AND processed_at IS NULL";
    await this.pool.query(sql, values);
  }
}
