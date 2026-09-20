import {
  PostgresAuditLogRepository,
  PostgresUsageSummaryRepository,
} from "@sculpin/db";
import type {
  AuditLogEntryView,
  AuditLogRepository,
  UsageSummaryRepository,
  UsageSummaryView,
} from "@sculpin/domain";
import { resolveAuthDependencies } from "./auth";
import { requireAdmin, type AuthzDeps } from "./session";

/**
 * §11 admin operational READ views (recent audit log + aggregate usage
 * summary).
 *
 * Both operations are gated by `requireAdmin`, which re-derives the caller's
 * platform role from the canonical `users` row (never the session), so only a
 * live, active admin can read the platform-wide log/summary. These are READS
 * about the whole platform — NO audit event is written for a read. The
 * repositories only expose fields the §10 / S13 writers already guarantee safe
 * (no token/secret/prompt/upstream url/upstream key/upstream agent id), and the
 * server-side limit clamp lives in the repository. Dependencies are injectable
 * so unit tests run without a database.
 */

const DEFAULT_AUDIT_LIMIT = 50;

export interface AuditViewDeps {
  readonly authz?: Partial<AuthzDeps>;
  readonly auditRepository?: AuditLogRepository;
  readonly usageRepository?: UsageSummaryRepository;
}

let defaultAuditRepositoryPromise: Promise<AuditLogRepository> | undefined;
let defaultUsageRepositoryPromise: Promise<UsageSummaryRepository> | undefined;

async function resolveAuditRepository(
  repository?: AuditLogRepository,
): Promise<AuditLogRepository> {
  if (repository) return repository;
  defaultAuditRepositoryPromise ??= (async () => {
    const { database } = resolveAuthDependencies();
    await database.ready();
    return new PostgresAuditLogRepository(database.pool);
  })();
  return defaultAuditRepositoryPromise;
}

async function resolveUsageRepository(
  repository?: UsageSummaryRepository,
): Promise<UsageSummaryRepository> {
  if (repository) return repository;
  defaultUsageRepositoryPromise ??= (async () => {
    const { database } = resolveAuthDependencies();
    await database.ready();
    return new PostgresUsageSummaryRepository(database.pool);
  })();
  return defaultUsageRepositoryPromise;
}

/**
 * Admin-gated: list the most recent audit events (newest first). The `limit` is
 * additionally CLAMPED server-side inside the repository so a caller can never
 * request unbounded rows.
 */
export async function listRecentAuditEvents(
  limit: number = DEFAULT_AUDIT_LIMIT,
  deps?: AuditViewDeps,
): Promise<readonly AuditLogEntryView[]> {
  await requireAdmin(deps?.authz);
  const repository = await resolveAuditRepository(deps?.auditRepository);
  return repository.listRecent(limit);
}

/**
 * Admin-gated: aggregate usage summary (total request count + total quota cost
 * over the recent window, with a small top-N per-organization breakdown).
 */
export async function getUsageSummary(
  deps?: AuditViewDeps,
): Promise<UsageSummaryView> {
  await requireAdmin(deps?.authz);
  const repository = await resolveUsageRepository(deps?.usageRepository);
  return repository.summarize();
}
