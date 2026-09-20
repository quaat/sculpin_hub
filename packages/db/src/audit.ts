/**
 * §10 — single-choke-point audit event writer for control-plane operations.
 *
 * Every product/security-significant mutation (PAT mint/revoke, catalogue CRUD,
 * plan CRUD, subscription claim/grant/status change) records ONE row in the
 * append-only `audit_events` table via {@link insertAuditEvent}, IN THE SAME
 * TRANSACTION as the mutation, so the mutation and its audit row commit together
 * or neither.
 *
 * HARD SECURITY RULE (fail closed — CLAUDE.md rules 2, 3, 4, 5): an audit row's
 * `before_summary` / `after_summary` MUST NEVER contain a raw PAT, the PAT
 * secret, the PAT HMAC digest, any OAuth credential, the Sculpin upstream URL or
 * upstream/discovery API key, a prompt, a model response, or a catalogue entry's
 * `upstream_agent_id`. Only SAFE metadata (names, public aliases, ids, status /
 * policy flags, counts, ISO timestamps) may appear. Callers are responsible for
 * shaping the summaries accordingly; this module never introspects nor logs them.
 *
 * A NULL `organizationId` denotes a PLATFORM-GLOBAL or admin-cross-org event
 * (catalogue/plan CRUD, admin subscription grant/status change): under Postgres
 * MATCH SIMPLE the composite membership FK is skipped when a referenced column is
 * NULL, while the separate `actor_user_id -> users` FK still validates the
 * responsible human. The affected org (if any) is named inside `after_summary`.
 */

/**
 * Minimal query surface satisfied by both `pg.Pool` and `pg.PoolClient`. Audit
 * writes always run against a `PoolClient` inside the mutation's transaction.
 */
export interface Queryable {
  query(
    text: string,
    values: readonly unknown[],
  ): Promise<{ rows: unknown[] }>;
}

/**
 * Exactly one actor: either a responsible human (`actorUserId`) or a trusted
 * system component (`systemActor`). The DB enforces the XOR via a CHECK.
 */
export type AuditActor =
  | { readonly actorUserId: string }
  | { readonly systemActor: string };

export interface AuditEventInput {
  /**
   * The tenant org the event belongs to, or NULL for a platform-global /
   * admin-cross-org event (the affected org, if any, is named in
   * `afterSummary`).
   */
  readonly organizationId: string | null;
  readonly actor: AuditActor;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  /**
   * SAFE metadata snapshots ONLY. NEVER a token/secret/digest/OAuth
   * credential/upstream url/upstream key/prompt/response/upstream agent id.
   */
  readonly beforeSummary?: Record<string, unknown> | null;
  readonly afterSummary?: Record<string, unknown> | null;
  readonly requestId: string;
}

/**
 * Insert a single audit row (append-only). Sets exactly one of
 * `actor_user_id` / `system_actor` (the other NULL), stamps `occurred_at = now()`
 * and serializes the JSON summaries to jsonb via `$n::jsonb` casts (matching the
 * style in `tenant.ts`). The caller MUST run this inside the same transaction as
 * the mutation being audited. See the module-level security rule for what MUST
 * NEVER appear in the summaries.
 */
export async function insertAuditEvent(
  db: Queryable,
  input: AuditEventInput,
): Promise<void> {
  const actorUserId =
    "actorUserId" in input.actor ? input.actor.actorUserId : null;
  const systemActor =
    "systemActor" in input.actor ? input.actor.systemActor : null;
  const before = input.beforeSummary ?? null;
  const after = input.afterSummary ?? null;
  await db.query(
    `INSERT INTO audit_events
       (organization_id, actor_user_id, system_actor, action, target_type,
        target_id, before_summary, after_summary, request_id, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9, now())`,
    [
      input.organizationId,
      actorUserId,
      systemActor,
      input.action,
      input.targetType,
      input.targetId,
      before === null ? null : JSON.stringify(before),
      after === null ? null : JSON.stringify(after),
      input.requestId,
    ],
  );
}
