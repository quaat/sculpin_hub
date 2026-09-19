export type UserId = string;
export type OrganizationId = string;

export interface TenantContext {
  readonly organizationId: OrganizationId;
  readonly actorUserId: UserId;
  readonly requestId: string;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  generate(): string;
}

export type UserStatus = "active" | "deactivated";
export type OrganizationStatus = "active" | "suspended";
export type OrganizationType = "personal" | "team";
export type MembershipStatus = "active" | "inactive";
export type MembershipRole = "owner" | "member";

export type SafeIdentityMetadata = Readonly<{
  schemaVersion: 1;
  issuer?: string;
  tenant?: string;
}>;

export interface ExternalIdentityInput {
  readonly provider: string;
  readonly providerSubject: string;
  readonly providerEmail?: string;
  readonly emailVerified: boolean;
  readonly metadata?: SafeIdentityMetadata;
}

export interface CreatePersonalTenantCommand {
  readonly normalizedEmail: string;
  readonly displayName: string;
  readonly locale: string;
  readonly organizationSlug: string;
  readonly requestId: string;
  readonly identity?: ExternalIdentityInput;
}

export interface PersonalTenantResult {
  readonly userId: UserId;
  readonly organizationId: OrganizationId;
}

export class DomainValidationError extends Error {
  override readonly name = "DomainValidationError";
}

export class DomainConflictError extends Error {
  override readonly name = "DomainConflictError";
  constructor(
    readonly code:
      | "identity_conflict"
      | "organization_slug_conflict"
      | "catalogue_alias_conflict",
  ) {
    super(code);
  }
}

export interface PersonalTenantTransaction {
  create(command: CreatePersonalTenantCommand): Promise<PersonalTenantResult>;
}

const normalizedEmailPattern =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const localePattern = /^[a-z]{2,3}(?:-[A-Z]{2}|-[A-Za-z]{4})?$/;
const slugPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const requestIdPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const providerPattern = /^[a-z][a-z0-9_-]{1,31}$/;
const providerSubjectPattern = /^[^\p{Cc}\s][^\p{Cc}]{0,254}$/u;
const displayNamePattern = /\S/u;
const sensitiveKeyPattern =
  /(authorization|cookie|token|secret|password|passphrase|api[-_ ]?key|client[-_ ]?secret|database[-_ ]?url|connection[-_ ]?string|credential|session)/i;

function normalizeKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

export function assertNoSensitiveKeys(value: unknown, path = "metadata"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertNoSensitiveKeys(item, `${path}[${index}]`),
    );
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (sensitiveKeyPattern.test(normalizeKey(key)))
      throw new DomainValidationError(`${path} contains a sensitive key.`);
    assertNoSensitiveKeys(nested, `${path}.${key}`);
  }
}

export function validateCreatePersonalTenantCommand(
  command: CreatePersonalTenantCommand,
): void {
  if (
    command.normalizedEmail.length > 254 ||
    !normalizedEmailPattern.test(command.normalizedEmail) ||
    command.normalizedEmail !== command.normalizedEmail.trim().toLowerCase()
  )
    throw new DomainValidationError(
      "Email must be normalized, valid, and at most 254 characters.",
    );
  if (
    command.displayName.length < 1 ||
    command.displayName.length > 120 ||
    !displayNamePattern.test(command.displayName)
  )
    throw new DomainValidationError(
      "Display name must be non-empty and at most 120 characters.",
    );
  if (!localePattern.test(command.locale) || command.locale.length > 16)
    throw new DomainValidationError(
      "Locale must use a documented BCP-47 subset such as en or en-US.",
    );
  if (!slugPattern.test(command.organizationSlug))
    throw new DomainValidationError(
      "Organization slug must be lower-case DNS-label style and at most 63 characters.",
    );
  if (!requestIdPattern.test(command.requestId))
    throw new DomainValidationError(
      "Request ID must be 1-128 safe correlation characters.",
    );
  if (!command.identity) return;
  if (!providerPattern.test(command.identity.provider))
    throw new DomainValidationError("Identity provider identifier is invalid.");
  if (!providerSubjectPattern.test(command.identity.providerSubject))
    throw new DomainValidationError("Identity provider subject is invalid.");
  if (
    command.identity.providerEmail &&
    (command.identity.providerEmail.length > 254 ||
      !normalizedEmailPattern.test(
        command.identity.providerEmail.toLowerCase(),
      ))
  )
    throw new DomainValidationError("Provider email is invalid.");
  if (command.identity.metadata) {
    if (command.identity.metadata.schemaVersion !== 1)
      throw new DomainValidationError(
        "Identity metadata schema version is unsupported.",
      );
    assertNoSensitiveKeys(command.identity.metadata);
  }
}

export class CreatePersonalTenantService {
  constructor(private readonly transactions: PersonalTenantTransaction) {}

  async execute(
    command: CreatePersonalTenantCommand,
  ): Promise<PersonalTenantResult> {
    validateCreatePersonalTenantCommand(command);
    return this.transactions.create(command);
  }
}

export interface MembershipRepository {
  list(
    context: TenantContext,
  ): Promise<readonly { userId: UserId; role: MembershipRole }[]>;
  findUser(
    context: TenantContext,
    userId: UserId,
  ): Promise<{ userId: UserId; role: MembershipRole } | undefined>;
}

export interface IdentityRepository {
  findUserId(
    provider: string,
    providerSubject: string,
  ): Promise<UserId | undefined>;
}

// ---------------------------------------------------------------------------
// M3 — Sculpin model catalogue
//
// The Hub publishes a curated map from a CLIENT-VISIBLE `publicAlias` (the
// OpenAI `model` id a caller sends to `/v1/*`) to an INTERNAL `upstreamAgentId`
// (the Sculpin agent slug/UUID). The alias is the only identifier ever exposed
// to clients; the upstream agent id and the internal Sculpin URL are never
// leaked (CLAUDE.md rules 3-4). Resolution is fail-closed: only a `published`
// entry maps an alias to its upstream agent id — `draft`/`disabled` entries
// never resolve. `toPublicModel` is the single projection that clients see; it
// is defined to structurally omit `upstreamAgentId` so a leak is impossible by
// construction.
// ---------------------------------------------------------------------------

export type CatalogueEntryStatus = "draft" | "published" | "disabled";

export interface CatalogueEntryInput {
  readonly publicAlias: string;
  readonly upstreamAgentId: string;
  readonly displayName: string;
  readonly description?: string;
}

export interface CatalogueEntry {
  readonly id: string;
  readonly publicAlias: string;
  readonly upstreamAgentId: string;
  readonly displayName: string;
  readonly description?: string;
  readonly status: CatalogueEntryStatus;
  readonly version: number;
}

/**
 * Client-safe projection of a catalogue entry. It deliberately carries NO
 * `upstreamAgentId` (and no internal ids), so passing it to a client can never
 * leak the upstream mapping.
 */
export interface PublicModel {
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
}

const catalogueAliasPattern = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const controlCharPattern = /[\p{Cc}\p{Cf}]/u;

export function validateCatalogueEntryInput(input: CatalogueEntryInput): void {
  if (!catalogueAliasPattern.test(input.publicAlias))
    throw new DomainValidationError(
      "Public alias must be 1-64 lower-case characters using a-z, 0-9, dot, hyphen, or underscore and start/end alphanumeric.",
    );
  const agentId = input.upstreamAgentId;
  if (
    agentId.length < 1 ||
    agentId.length > 255 ||
    agentId !== agentId.trim() ||
    controlCharPattern.test(agentId)
  )
    throw new DomainValidationError(
      "Upstream agent id must be 1-255 trimmed characters with no control characters.",
    );
  if (
    input.displayName.length < 1 ||
    input.displayName.length > 120 ||
    !displayNamePattern.test(input.displayName)
  )
    throw new DomainValidationError(
      "Display name must be non-empty and at most 120 characters.",
    );
  if (
    input.description !== undefined &&
    (input.description.length > 2048 || controlCharPattern.test(input.description))
  )
    throw new DomainValidationError(
      "Description must be at most 2048 characters with no control characters.",
    );
}

export function toPublicModel(entry: CatalogueEntry): PublicModel {
  return {
    id: entry.publicAlias,
    displayName: entry.displayName,
    ...(entry.description !== undefined
      ? { description: entry.description }
      : {}),
  };
}

export interface CatalogueRepository {
  create(
    input: CatalogueEntryInput,
    adminUserId: UserId,
  ): Promise<CatalogueEntry>;
  publish(id: string, adminUserId: UserId): Promise<CatalogueEntry | undefined>;
  unpublish(
    id: string,
    adminUserId: UserId,
  ): Promise<CatalogueEntry | undefined>;
  listAll(): Promise<readonly CatalogueEntry[]>;
  listPublished(): Promise<readonly PublicModel[]>;
  resolvePublishedAlias(alias: string): Promise<{ upstreamAgentId: string } | undefined>;
}

// ---------------------------------------------------------------------------
// M4 — Subscriptions & entitlements (NO payment provider; D-004)
//
// Every tenant gets a `trial` subscription at provisioning so that having a
// valid PAT/session is NOT by itself sufficient to call `/v1/*` — access is
// gated on an ACTIVE, in-quota entitlement (D-015). An entitlement is the UNION
// of a tenant's active subscriptions: a subscription counts when its status is
// `active` and it is within its validity window (`endsAt` in the future or
// open-ended). There is no payment provider in v1; `commercial` subscriptions
// are provisioned administratively. Quota reservation MUST be atomic (a single
// conditional UPDATE, never read-compare-write) so concurrent last-quota
// attempts cannot over-draw (CLAUDE.md rule 6) — the repository owns that SQL;
// the pure helpers here (`resolveEntitlement`, the state machine) stay
// deterministic and side-effect free for unit testing.
// ---------------------------------------------------------------------------

export type SubscriptionPlan = "trial" | "commercial";
export type SubscriptionStatus = "active" | "canceled" | "expired";

/** Default request budget granted to a new personal tenant's trial. */
export const TRIAL_REQUEST_QUOTA = 200;

export interface Subscription {
  readonly id: string;
  readonly organizationId: OrganizationId;
  readonly plan: SubscriptionPlan;
  readonly status: SubscriptionStatus;
  readonly quotaLimit: number;
  readonly quotaUsed: number;
  readonly startsAt: Date;
  readonly endsAt?: Date;
  readonly version: number;
}

// Subscription state machine. `active` is the only non-terminal state; both
// `canceled` and `expired` are terminal (a new subscription is created rather
// than reactivating a dead one). Kept as data so the transition set is auditable.
const subscriptionTransitions: Readonly<
  Record<SubscriptionStatus, readonly SubscriptionStatus[]>
> = {
  active: ["canceled", "expired"],
  canceled: [],
  expired: [],
};

export function canTransitionSubscription(
  from: SubscriptionStatus,
  to: SubscriptionStatus,
): boolean {
  return subscriptionTransitions[from].includes(to);
}

export function assertSubscriptionTransition(
  from: SubscriptionStatus,
  to: SubscriptionStatus,
): void {
  if (!canTransitionSubscription(from, to))
    throw new DomainValidationError(
      `Illegal subscription transition ${from} -> ${to}.`,
    );
}

export function isSubscriptionActive(
  subscription: Subscription,
  now: Date,
): boolean {
  return (
    subscription.status === "active" &&
    (subscription.endsAt === undefined ||
      subscription.endsAt.getTime() > now.getTime())
  );
}

/**
 * Resolved access state for a tenant: the union of its active subscriptions.
 * `active` is true when at least one subscription is active and in-window;
 * `remainingQuota` is the pooled unused budget across those subscriptions.
 */
export interface Entitlement {
  readonly organizationId: OrganizationId;
  readonly active: boolean;
  readonly plans: readonly SubscriptionPlan[];
  readonly remainingQuota: number;
}

export function resolveEntitlement(
  organizationId: OrganizationId,
  subscriptions: readonly Subscription[],
  now: Date,
): Entitlement {
  const activeSubscriptions = subscriptions.filter((subscription) =>
    isSubscriptionActive(subscription, now),
  );
  const plans = [
    ...new Set(activeSubscriptions.map((subscription) => subscription.plan)),
  ].sort();
  const remainingQuota = activeSubscriptions.reduce(
    (sum, subscription) =>
      sum + Math.max(0, subscription.quotaLimit - subscription.quotaUsed),
    0,
  );
  return {
    organizationId,
    active: activeSubscriptions.length > 0,
    plans,
    remainingQuota,
  };
}

export function validateQuotaAmount(amount: number): void {
  if (!Number.isInteger(amount) || amount < 1 || amount > 1000)
    throw new DomainValidationError(
      "Quota reservation amount must be an integer between 1 and 1000.",
    );
}

/**
 * Result of an atomic quota reservation. `granted` is true only when the
 * repository's conditional UPDATE claimed the amount from an active, in-quota
 * subscription; `remainingQuota` is the tenant's pooled remaining budget after
 * the attempt (0 on a denied, exhausted tenant).
 */
export interface QuotaReservation {
  readonly granted: boolean;
  readonly remainingQuota: number;
}

export interface SubscriptionRepository {
  listForOrganization(
    organizationId: OrganizationId,
  ): Promise<readonly Subscription[]>;
  /**
   * Atomically reserve `amount` of request quota from the tenant's active
   * subscriptions. MUST be a single conditional UPDATE (no read-compare-write)
   * so concurrent last-quota attempts cannot over-draw.
   */
  reserveQuota(
    organizationId: OrganizationId,
    amount: number,
  ): Promise<QuotaReservation>;
  /** Terminal transition of an active subscription (state machine enforced). */
  setStatus(
    id: string,
    status: SubscriptionStatus,
  ): Promise<Subscription | undefined>;
}
