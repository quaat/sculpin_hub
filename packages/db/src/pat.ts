import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  formatPatToken,
  parsePatToken,
  validatePatName,
  validatePatScopeIds,
  PAT_PUBLIC_ID_LENGTH,
  PAT_SECRET_LENGTH,
  type MintedPat,
  type OrganizationId,
  type PatIdentity,
  type PatRecord,
  type UserId,
} from "@sculpin/domain";
import type { Pool, PoolClient } from "pg";
import { insertAuditEvent } from "./audit.js";

const BASE62_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
// 62 * 4 = 248: reject bytes >= 248 so that `byte % 62` is uniform (no modulo
// bias). ~3% of bytes are rejected and resampled.
const BASE62_REJECT_THRESHOLD = 248;

/** Uniformly sample `length` base62 characters from a CSPRNG (no modulo bias). */
function randomBase62(length: number): string {
  let out = "";
  while (out.length < length) {
    const bytes = randomBytes(length - out.length + 8);
    for (let i = 0; i < bytes.length && out.length < length; i += 1) {
      const b = bytes[i]!;
      if (b < BASE62_REJECT_THRESHOLD) out += BASE62_ALPHABET[b % 62];
    }
  }
  return out;
}

/** HMAC-SHA-256(secret) keyed by a PAT hash key, base64. Never store the raw secret. */
export function hashPatSecret(secret: string, key: string): string {
  return createHmac("sha256", key).update(secret, "utf8").digest("base64");
}

/**
 * Constant-time comparison of a candidate secret's keyed digest against a stored
 * digest. Uses timingSafeEqual on equal-length buffers; unequal lengths short
 * out but that never leaks the secret (both operands are HMAC outputs).
 */
export function verifyPatSecretHash(
  secret: string,
  key: string,
  storedHash: string,
): boolean {
  const candidate = Buffer.from(hashPatSecret(secret, key), "utf8");
  const stored = Buffer.from(storedHash, "utf8");
  if (candidate.length !== stored.length) return false;
  return timingSafeEqual(candidate, stored);
}

/**
 * A versioned keyring of PAT HMAC secrets. `PAT_HASH_SECRET` may be ROTATED
 * without invalidating live tokens: each PAT row stamps the key version it was
 * hashed under (`hash_key_version`), and verification looks up THAT version's
 * key. `currentVersion` is the version new tokens are minted under and MUST be
 * present in `keys`. Retired keys stay in `keys` so old tokens keep verifying.
 * The keys never touch the DB, browsers, logs, usage events, or responses.
 */
export interface PatKeyring {
  readonly currentVersion: number;
  readonly keys: ReadonlyMap<number, string>;
}

interface PatScopeRow {
  scopes: string[] | null;
}

interface PatRow extends PatScopeRow {
  id: string;
  publicId: string;
  userId: string;
  organizationId: string;
  name: string;
  status: PatRecord["status"];
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
}

// Aggregate the immutable scope rows into a sorted text[] (empty when unscoped)
// so a single SELECT returns the full record. COALESCE keeps unscoped PATs as an
// empty array rather than NULL.
const SCOPE_AGG =
  `COALESCE((SELECT array_agg(s.catalogue_entry_id::text ORDER BY s.catalogue_entry_id)` +
  ` FROM personal_access_token_scopes s WHERE s.pat_id = pat.id), ARRAY[]::text[]) AS "scopes"`;

const PAT_SELECT_COLUMNS =
  `pat.id, pat.public_id AS "publicId", pat.user_id AS "userId", pat.organization_id AS "organizationId",` +
  ` pat.name, pat.status, pat.created_at AS "createdAt", pat.last_used_at AS "lastUsedAt",` +
  ` pat.expires_at AS "expiresAt", ${SCOPE_AGG}`;

function mapRow(row: PatRow): PatRecord {
  return {
    id: row.id,
    publicId: row.publicId,
    userId: row.userId,
    organizationId: row.organizationId,
    name: row.name,
    status: row.status,
    createdAt: row.createdAt,
    scopes: row.scopes ?? [],
    ...(row.lastUsedAt !== null ? { lastUsedAt: row.lastUsedAt } : {}),
    ...(row.expiresAt !== null ? { expiresAt: row.expiresAt } : {}),
  };
}

export interface MintPatCommand {
  readonly userId: UserId;
  readonly organizationId: OrganizationId;
  readonly name: string;
  readonly expiresAt?: Date;
  /**
   * Immutable catalogue-entry scopes to stamp at mint. Empty/omitted = unscoped
   * (inherit the principal's full entitlement). Each id must EXIST in
   * `catalogue_entries` or the entire mint rolls back.
   */
  readonly scopeCatalogueEntryIds?: readonly string[];
  /** Safe correlation id recorded on the mint audit event. */
  readonly requestId: string;
}

function assertKeyring(keyring: PatKeyring): void {
  if (
    !keyring ||
    !Number.isInteger(keyring.currentVersion) ||
    keyring.currentVersion <= 0
  )
    throw new Error("PAT keyring current version must be a positive integer.");
  if (!(keyring.keys instanceof Map) && !isReadonlyMap(keyring.keys))
    throw new Error("PAT keyring keys must be a Map.");
  for (const [version, key] of keyring.keys) {
    if (!Number.isInteger(version) || version <= 0)
      throw new Error("PAT keyring versions must be positive integers.");
    if (typeof key !== "string" || key.length < 32)
      throw new Error("Every PAT hash key must be at least 32 characters.");
  }
  if (!keyring.keys.has(keyring.currentVersion))
    throw new Error(
      "PAT keyring must contain a key for its current version.",
    );
}

function isReadonlyMap(value: unknown): value is ReadonlyMap<number, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ReadonlyMap<number, string>).get === "function" &&
    typeof (value as ReadonlyMap<number, string>).has === "function"
  );
}

/**
 * Personal Access Token data-plane service (CLAUDE.md rule 2). Persists only the
 * HMAC-SHA-256 keyed digest of the secret; the raw token is returned exactly
 * once from `mint`. `authenticate` re-derives an active user/org/membership from
 * the DB and verifies the secret in constant time using the key for the row's
 * stamped version, computing a dummy HMAC (with the CURRENT key) on every miss —
 * including an unknown key version — so a lookup miss, an unknown version, and a
 * wrong secret are indistinguishable by timing.
 */
export class PostgresPatService {
  private readonly keyring: PatKeyring;
  private readonly currentKey: string;
  private readonly dummyHash: string;

  constructor(
    private readonly pool: Pool,
    keyring: PatKeyring,
  ) {
    assertKeyring(keyring);
    this.keyring = keyring;
    this.currentKey = keyring.keys.get(keyring.currentVersion)!;
    // A stable, meaningless digest to compare against on any not-found / unknown
    // key-version path so those cost the same as the happy path (timing). Uses
    // the current key so it is always available.
    this.dummyHash = hashPatSecret(" dummy-secret", this.currentKey);
  }

  async mint(command: MintPatCommand): Promise<MintedPat> {
    validatePatName(command.name);
    const scopeIds = command.scopeCatalogueEntryIds ?? [];
    validatePatScopeIds(scopeIds);
    const publicId = randomBase62(PAT_PUBLIC_ID_LENGTH);
    const secret = randomBase62(PAT_SECRET_LENGTH);
    const token = formatPatToken(publicId, secret);
    const secretHash = hashPatSecret(secret, this.currentKey);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO personal_access_tokens
           (public_id, user_id, organization_id, name, secret_hash, hash_key_version, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id`,
        [
          publicId,
          command.userId,
          command.organizationId,
          command.name.trim(),
          secretHash,
          this.keyring.currentVersion,
          command.expiresAt ?? null,
        ],
      );
      const patId = inserted.rows[0]?.id;
      if (!patId) throw new Error("pat_insert_failed");
      if (scopeIds.length > 0) {
        // INSERT ... SELECT only rows whose catalogue_entry EXISTS. If any
        // requested id is unknown, the inserted rowcount is below the requested
        // count and we roll back — a scope naming a non-existent entry is
        // rejected atomically (nothing persisted).
        const scoped = await client.query(
          `INSERT INTO personal_access_token_scopes (pat_id, catalogue_entry_id)
           SELECT $1::uuid, ce.id
           FROM catalogue_entries ce
           WHERE ce.id = ANY($2::uuid[])`,
          [patId, [...scopeIds]],
        );
        if (scoped.rowCount !== scopeIds.length) {
          throw new PatScopeUnknownError();
        }
      }
      const row = await this.selectRow(client, patId);
      if (!row) throw new Error("pat_insert_failed");
      // Audit the mint in the SAME transaction. The user is the org's
      // owner-member, so the event is org-scoped and the composite membership FK
      // is satisfied. The summary carries ONLY safe metadata — NEVER the token,
      // the secret, or its HMAC digest (CLAUDE.md rules 2, 5).
      await insertAuditEvent(client, {
        organizationId: command.organizationId,
        actor: { actorUserId: command.userId },
        action: "pat.minted",
        targetType: "personal_access_token",
        targetId: patId,
        afterSummary: {
          name: command.name.trim(),
          scoped: scopeIds.length > 0,
          scopeCount: scopeIds.length,
          expiresAt: command.expiresAt ? command.expiresAt.toISOString() : null,
        },
        requestId: command.requestId,
      });
      await client.query("COMMIT");
      return { record: mapRow(row), token };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async selectRow(
    client: PoolClient,
    id: string,
  ): Promise<PatRow | undefined> {
    const result = await client.query<PatRow>(
      `SELECT ${PAT_SELECT_COLUMNS} FROM personal_access_tokens pat WHERE pat.id = $1`,
      [id],
    );
    return result.rows[0];
  }

  /**
   * Resolve a raw PAT to a caller identity, or `undefined` for ANY failure
   * (malformed, unknown, revoked, expired, wrong secret, inactive user/org/
   * membership, unknown key version). Callers MUST NOT branch on the reason — a
   * single opaque failure avoids an authentication oracle.
   */
  async authenticate(raw: string): Promise<PatIdentity | undefined> {
    const parsed = parsePatToken(raw);
    // Look up only when the token is well-formed; otherwise still burn a compare
    // against the dummy hash to keep timing uniform. The scope aggregate rides
    // along in the same SELECT so authentication stays a single lookup.
    const lookup = parsed
      ? await this.pool.query<{
          id: string;
          userId: string;
          organizationId: string;
          secretHash: string;
          hashKeyVersion: number;
          scopes: string[] | null;
        }>(
          `SELECT pat.id AS "id", pat.user_id AS "userId", pat.organization_id AS "organizationId",
                  pat.secret_hash AS "secretHash", pat.hash_key_version AS "hashKeyVersion",
                  ${SCOPE_AGG}
           FROM personal_access_tokens pat
           JOIN users u ON u.id = pat.user_id
           JOIN organizations o ON o.id = pat.organization_id
           JOIN organization_memberships m ON m.organization_id = pat.organization_id AND m.user_id = pat.user_id
           WHERE pat.public_id = $1
             AND pat.status = 'active'
             AND (pat.expires_at IS NULL OR pat.expires_at > now())
             AND u.status = 'active'
             AND o.status = 'active'
             AND m.status = 'active'`,
          [parsed.publicId],
        )
      : undefined;
    const found = lookup?.rows[0];
    // Resolve the verification key from the row's stamped version. An unknown
    // version yields no key; we still verify against the dummy hash with the
    // current key so the timing and result are identical to a lookup miss.
    const versionKey =
      found !== undefined
        ? this.keyring.keys.get(found.hashKeyVersion)
        : undefined;
    const secret = parsed?.secret ?? " ";
    const key = versionKey ?? this.currentKey;
    const storedHash = versionKey ? found!.secretHash : this.dummyHash;
    const ok = verifyPatSecretHash(secret, key, storedHash);
    if (!parsed || !found || !versionKey || !ok) return undefined;
    await this.pool.query(
      "UPDATE personal_access_tokens SET last_used_at = now() WHERE id = $1",
      [found.id],
    );
    return {
      patId: found.id,
      userId: found.userId,
      organizationId: found.organizationId,
      scopes: found.scopes ?? [],
    };
  }

  /**
   * Revoke a PAT owned by `userId`. Idempotent: revoking an already-revoked or
   * unknown token returns `undefined`. Scoped to the owner so a caller can only
   * revoke their own tokens.
   */
  async revoke(
    id: string,
    userId: UserId,
    requestId: string,
  ): Promise<PatRecord | undefined> {
    // RETURNING sees the POST-update row; the scope aggregate rides along as a
    // correlated subquery (scopes are immutable, so they are unaffected by the
    // status change). `pat` is the UPDATE target alias so PAT_SELECT_COLUMNS and
    // SCOPE_AGG resolve unchanged. The revoke + its audit row commit together.
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<PatRow>(
        `UPDATE personal_access_tokens AS pat
         SET status = 'revoked', revoked_at = now(), updated_at = now(), version = version + 1
         WHERE pat.id = $1 AND pat.user_id = $2 AND pat.status = 'active'
         RETURNING ${PAT_SELECT_COLUMNS}`,
        [id, userId],
      );
      const row = result.rows[0];
      if (!row) {
        // Unknown / already-revoked token: idempotent no-op, no audit row.
        await client.query("ROLLBACK");
        return undefined;
      }
      const record = mapRow(row);
      await insertAuditEvent(client, {
        organizationId: record.organizationId,
        actor: { actorUserId: userId },
        action: "pat.revoked",
        targetType: "personal_access_token",
        targetId: id,
        beforeSummary: { status: "active" },
        afterSummary: { status: "revoked" },
        requestId,
      });
      await client.query("COMMIT");
      return record;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // ignore — the transaction was already resolved.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async listForUser(userId: UserId): Promise<readonly PatRecord[]> {
    const result = await this.pool.query<PatRow>(
      `SELECT ${PAT_SELECT_COLUMNS} FROM personal_access_tokens pat
       WHERE pat.user_id = $1 ORDER BY pat.created_at DESC, pat.id`,
      [userId],
    );
    return result.rows.map(mapRow);
  }
}

/**
 * A requested mint scope named a catalogue entry that does not exist. Thrown
 * inside the mint transaction so nothing is persisted (fail-closed).
 */
export class PatScopeUnknownError extends Error {
  override readonly name = "PatScopeUnknownError";
  constructor() {
    super("One or more PAT scope catalogue-entry ids do not exist.");
  }
}
