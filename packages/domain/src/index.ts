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
      | "catalogue_alias_conflict"
      | "plan_already_claimed",
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
// M4 — Plans, subscriptions & entitlements (NO payment provider; D-004/D-019)
//
// A `Plan` is an admin-configurable product (free trial, commercial monthly,
// commercial annual). Its `plan_catalogue_entries` M2M is the AUTHORITATIVE set
// of Sculpin agents the plan grants. A tenant obtains access by EXPLICITLY
// claiming a plan (`grantFromPlan`), which materializes a `Subscription` and, at
// grant time, SNAPSHOTS the plan's kind and its catalogue-entry set onto the
// subscription. Later plan edits therefore NEVER retroactively change an
// existing subscription. A newly provisioned tenant has NO subscription until it
// claims one — a valid credential alone is not sufficient to call `/v1/*`.
//
// Entitlement is the UNION of a tenant's active subscriptions: a subscription
// counts when its status is `active` and it is within its validity window
// (`endsAt` in the future or open-ended). `suspended` is NOT active/entitling.
// The entitled catalogue-entry ids are the composable seam a later milestone
// intersects with the published catalogue + PAT scopes. Quota reservation MUST
// be atomic (a single conditional UPDATE, never read-compare-write) so
// concurrent last-quota attempts cannot over-draw (CLAUDE.md rule 6) — the
// repository owns that SQL; the pure helpers here stay deterministic and
// side-effect free for unit testing.
// ---------------------------------------------------------------------------

export type PlanKind =
  | "free_trial"
  | "commercial_monthly"
  | "commercial_annual";

const planKinds: readonly PlanKind[] = [
  "free_trial",
  "commercial_monthly",
  "commercial_annual",
];

export interface Plan {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly description?: string;
  readonly kind: PlanKind;
  readonly enabled: boolean;
  readonly published: boolean;
  readonly selfServiceEligible: boolean;
  readonly adminGrantable: boolean;
  readonly durationDays?: number;
  readonly requestQuota: number;
  readonly oneTimePerOrganization: boolean;
  readonly version: number;
  /** Admin-configured catalogue-entry ids this plan grants (authoritative). */
  readonly catalogueEntryIds: readonly string[];
}

export interface PlanInput {
  readonly key: string;
  readonly name: string;
  readonly description?: string;
  readonly kind: PlanKind;
  readonly selfServiceEligible?: boolean;
  readonly adminGrantable?: boolean;
  readonly durationDays?: number;
  readonly requestQuota: number;
  readonly oneTimePerOrganization?: boolean;
}

const planKeyPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function validatePlanInput(input: PlanInput): void {
  if (typeof input.key !== "string" || !planKeyPattern.test(input.key))
    throw new DomainValidationError(
      "Plan key must be a 1-63 lower-case DNS-label style slug.",
    );
  if (
    input.name.length < 1 ||
    input.name.length > 120 ||
    !displayNamePattern.test(input.name)
  )
    throw new DomainValidationError(
      "Plan name must be non-empty and at most 120 characters.",
    );
  if (
    input.description !== undefined &&
    (input.description.length > 2048 || controlCharPattern.test(input.description))
  )
    throw new DomainValidationError(
      "Plan description must be at most 2048 characters with no control characters.",
    );
  if (!planKinds.includes(input.kind))
    throw new DomainValidationError("Plan kind is unsupported.");
  if (
    !Number.isInteger(input.requestQuota) ||
    input.requestQuota < 0 ||
    input.requestQuota > 1_000_000
  )
    throw new DomainValidationError(
      "Plan request quota must be an integer between 0 and 1000000.",
    );
  if (
    input.durationDays !== undefined &&
    (!Number.isInteger(input.durationDays) ||
      input.durationDays < 1 ||
      input.durationDays > 3650)
  )
    throw new DomainValidationError(
      "Plan duration must be an integer number of days between 1 and 3650.",
    );
}

export type SubscriptionStatus =
  | "active"
  | "suspended"
  | "canceled"
  | "expired";

export interface Subscription {
  readonly id: string;
  readonly organizationId: OrganizationId;
  readonly planId: string;
  readonly planKey: string;
  /** SNAPSHOT of the plan's kind at grant time. */
  readonly planKind: PlanKind;
  readonly status: SubscriptionStatus;
  readonly quotaLimit: number;
  readonly quotaUsed: number;
  readonly startsAt: Date;
  readonly endsAt?: Date;
  /** SNAPSHOT of the plan's catalogue-entry ids at grant time. */
  readonly offerings: readonly string[];
  readonly version: number;
}

// Subscription state machine. `active` and `suspended` are the non-terminal
// states: an active subscription can be suspended (temporarily not entitling)
// and resumed, or moved to a terminal state; `canceled`/`expired` are terminal
// (a new subscription is created rather than reactivating a dead one). Kept as
// data so the transition set is auditable.
const subscriptionTransitions: Readonly<
  Record<SubscriptionStatus, readonly SubscriptionStatus[]>
> = {
  active: ["suspended", "canceled", "expired"],
  suspended: ["active", "canceled", "expired"],
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
 * `remainingQuota` is the pooled unused budget; `entitledCatalogueEntryIds` is
 * the sorted, de-duplicated union of the active subscriptions' snapshot
 * offerings — the composable seam a later milestone intersects with the
 * published catalogue + PAT scopes.
 */
export interface Entitlement {
  readonly organizationId: OrganizationId;
  readonly active: boolean;
  readonly planKeys: readonly string[];
  readonly remainingQuota: number;
  readonly entitledCatalogueEntryIds: readonly string[];
}

export function resolveEntitlement(
  organizationId: OrganizationId,
  subscriptions: readonly Subscription[],
  now: Date,
): Entitlement {
  const activeSubscriptions = subscriptions.filter((subscription) =>
    isSubscriptionActive(subscription, now),
  );
  const planKeys = [
    ...new Set(activeSubscriptions.map((subscription) => subscription.planKey)),
  ].sort();
  const remainingQuota = activeSubscriptions.reduce(
    (sum, subscription) =>
      sum + Math.max(0, subscription.quotaLimit - subscription.quotaUsed),
    0,
  );
  const entitledCatalogueEntryIds = [
    ...new Set(
      activeSubscriptions.flatMap((subscription) => subscription.offerings),
    ),
  ].sort();
  return {
    organizationId,
    active: activeSubscriptions.length > 0,
    planKeys,
    remainingQuota,
    entitledCatalogueEntryIds,
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

export interface PlanPatch {
  readonly name?: string;
  readonly description?: string;
  readonly selfServiceEligible?: boolean;
  readonly adminGrantable?: boolean;
  readonly durationDays?: number | null;
  readonly requestQuota?: number;
  readonly oneTimePerOrganization?: boolean;
}

export interface PlanRepository {
  create(input: PlanInput, adminUserId: UserId): Promise<Plan>;
  update(
    id: string,
    patch: PlanPatch,
    adminUserId: UserId,
  ): Promise<Plan | undefined>;
  setEnabled(
    id: string,
    enabled: boolean,
    adminUserId: UserId,
  ): Promise<Plan | undefined>;
  setPublished(
    id: string,
    published: boolean,
    adminUserId: UserId,
  ): Promise<Plan | undefined>;
  attachCatalogueEntry(
    planId: string,
    catalogueEntryId: string,
  ): Promise<Plan | undefined>;
  detachCatalogueEntry(
    planId: string,
    catalogueEntryId: string,
  ): Promise<Plan | undefined>;
  listAll(): Promise<readonly Plan[]>;
  listSelfServicePublished(): Promise<readonly Plan[]>;
  findById(id: string): Promise<Plan | undefined>;
  findByKey(key: string): Promise<Plan | undefined>;
}

export interface SubscriptionRepository {
  listForOrganization(
    organizationId: OrganizationId,
  ): Promise<readonly Subscription[]>;
  /**
   * Explicitly claim a plan for an organization: materialize a new active
   * subscription in ONE transaction, snapshotting the plan's kind and its
   * catalogue-entry set. When the plan is one-time-per-organization, a
   * `plan_claims` row is inserted so a second claim fails
   * (`DomainConflictError("plan_already_claimed")`). Throws
   * `DomainValidationError` when the plan is missing or disabled.
   */
  grantFromPlan(
    organizationId: OrganizationId,
    planId: string,
    actorUserId: UserId,
  ): Promise<Subscription>;
  /**
   * Atomically reserve `amount` of request quota from the tenant's active
   * subscriptions. MUST be a single conditional UPDATE (no read-compare-write)
   * so concurrent last-quota attempts cannot over-draw.
   */
  reserveQuota(
    organizationId: OrganizationId,
    amount: number,
  ): Promise<QuotaReservation>;
  /**
   * Transition a subscription through the state machine (suspend/resume/
   * terminal). Returns undefined on an illegal or no-op transition.
   */
  setStatus(
    id: string,
    status: SubscriptionStatus,
  ): Promise<Subscription | undefined>;
}

// ---------------------------------------------------------------------------
// M5 — Personal Access Tokens (PATs)
//
// Wire format: `sclp_pat_<public-id>_<secret>` (CLAUDE.md rule 2). The public
// id is an unauthenticated lookup handle; the secret is the bearer proof. Only
// an HMAC-SHA-256 keyed digest of the secret is ever persisted (see db/pat.ts),
// so a DB leak yields no usable credentials. These helpers are pure (no crypto,
// no I/O) so they can run in any layer and stay deterministically testable.
// ---------------------------------------------------------------------------

export const PAT_PREFIX = "sclp_pat_";
/** 22 base62 chars ≈ 131 bits — an opaque, unguessable lookup handle. */
export const PAT_PUBLIC_ID_LENGTH = 22;
/** 43 base62 chars ≈ 256 bits — the high-entropy bearer secret. */
export const PAT_SECRET_LENGTH = 43;

const patPublicIdPattern = /^[0-9A-Za-z]{22}$/;
const patSecretPattern = /^[0-9A-Za-z]{43}$/;

export type PatStatus = "active" | "revoked";

export interface ParsedPatToken {
  readonly publicId: string;
  readonly secret: string;
}

/**
 * Parse a raw PAT into its public id and secret. Returns `undefined` for any
 * malformed token — callers MUST treat that identically to an authentication
 * failure (never branch on the specific reason, to avoid a parsing oracle).
 */
export function parsePatToken(raw: string): ParsedPatToken | undefined {
  if (typeof raw !== "string" || !raw.startsWith(PAT_PREFIX)) return undefined;
  const remainder = raw.slice(PAT_PREFIX.length);
  const separator = remainder.indexOf("_");
  if (separator <= 0) return undefined;
  const publicId = remainder.slice(0, separator);
  const secret = remainder.slice(separator + 1);
  if (!patPublicIdPattern.test(publicId) || !patSecretPattern.test(secret))
    return undefined;
  return { publicId, secret };
}

/** Assemble the one-time display token from its parts. */
export function formatPatToken(publicId: string, secret: string): string {
  if (!patPublicIdPattern.test(publicId))
    throw new DomainValidationError("PAT public id is invalid.");
  if (!patSecretPattern.test(secret))
    throw new DomainValidationError("PAT secret is invalid.");
  return `${PAT_PREFIX}${publicId}_${secret}`;
}

export function validatePatName(name: string): void {
  if (typeof name !== "string")
    throw new DomainValidationError("PAT name is required.");
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 120 || controlCharPattern.test(name))
    throw new DomainValidationError(
      "PAT name must be 1-120 printable characters.",
    );
}

/**
 * A stored PAT record. NEVER carries the raw secret or its digest — the digest
 * lives only in the data layer and is never surfaced to callers.
 */
export interface PatRecord {
  readonly id: string;
  readonly publicId: string;
  readonly userId: UserId;
  readonly organizationId: OrganizationId;
  readonly name: string;
  readonly status: PatStatus;
  readonly createdAt: Date;
  readonly lastUsedAt?: Date;
  readonly expiresAt?: Date;
}

/** Resolved caller identity after a successful PAT authentication. */
export interface PatIdentity {
  readonly patId: string;
  readonly userId: UserId;
  readonly organizationId: OrganizationId;
}

/** A freshly minted PAT: the record plus the ONE-TIME raw token to display. */
export interface MintedPat {
  readonly record: PatRecord;
  readonly token: string;
}
