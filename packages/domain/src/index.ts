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
  /**
   * Admin-authored, client-SAFE "how to use this offering" prose shown on the
   * Connect page. Multi-line plain text (tabs/newlines allowed); MUST NOT
   * reference the internal Sculpin URL / credential / upstream agent id — that
   * is a human authoring responsibility, but the value itself is public by
   * design and carries no internal identifier by construction.
   */
  readonly accessInstructions?: string;
}

export interface CatalogueEntry {
  readonly id: string;
  readonly publicAlias: string;
  readonly upstreamAgentId: string;
  readonly displayName: string;
  readonly description?: string;
  readonly accessInstructions?: string;
  readonly status: CatalogueEntryStatus;
  readonly version: number;
}

/**
 * Client-safe projection of a catalogue entry. It deliberately carries NO
 * `upstreamAgentId` (and no internal ids), so passing it to a client can never
 * leak the upstream mapping. `accessInstructions` is admin-authored public prose
 * and is safe to expose here.
 */
export interface PublicModel {
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
  readonly accessInstructions?: string;
}

/**
 * Metadata-only patch for a stored catalogue entry. It deliberately CANNOT
 * carry `publicAlias` or `upstreamAgentId`: the alias↔upstream-agent mapping is
 * immutable once created so a published alias can never be silently re-pointed
 * at a different upstream agent (CLAUDE.md rules 3-4). Only human-facing display
 * metadata is editable.
 */
export interface CatalogueEntryMetadataPatch {
  readonly displayName?: string;
  readonly description?: string | null;
  readonly accessInstructions?: string | null;
}

const catalogueAliasPattern = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const controlCharPattern = /[\p{Cc}\p{Cf}]/u;
const ACCESS_INSTRUCTIONS_MAX = 4096;

/**
 * Multi-line prose control-char check: tabs / newlines / carriage returns are
 * permitted (access instructions are multi-line), every other control or format
 * character is rejected.
 */
function hasDisallowedProseControlChars(text: string): boolean {
  return controlCharPattern.test(text.replace(/[\t\n\r]/g, ""));
}

function validateAccessInstructions(value: string): void {
  if (value.length > ACCESS_INSTRUCTIONS_MAX || hasDisallowedProseControlChars(value))
    throw new DomainValidationError(
      `Access instructions must be at most ${ACCESS_INSTRUCTIONS_MAX} characters with no control characters other than tabs and newlines.`,
    );
}

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
  if (input.accessInstructions !== undefined)
    validateAccessInstructions(input.accessInstructions);
}

/**
 * Validate a metadata-only patch (display name / description / access
 * instructions). `null` clears the optional description / access-instructions
 * columns; a provided string is bounds-checked as on create. Fails closed on any
 * out-of-range field before the repository touches the DB.
 */
export function validateCatalogueEntryMetadataPatch(
  patch: CatalogueEntryMetadataPatch,
): void {
  if (patch.displayName !== undefined) {
    if (
      patch.displayName.length < 1 ||
      patch.displayName.length > 120 ||
      !displayNamePattern.test(patch.displayName)
    )
      throw new DomainValidationError(
        "Display name must be non-empty and at most 120 characters.",
      );
  }
  if (patch.description !== undefined && patch.description !== null) {
    if (
      patch.description.length > 2048 ||
      controlCharPattern.test(patch.description)
    )
      throw new DomainValidationError(
        "Description must be at most 2048 characters with no control characters.",
      );
  }
  if (patch.accessInstructions !== undefined && patch.accessInstructions !== null)
    validateAccessInstructions(patch.accessInstructions);
}

export function toPublicModel(entry: CatalogueEntry): PublicModel {
  return {
    id: entry.publicAlias,
    displayName: entry.displayName,
    ...(entry.description !== undefined
      ? { description: entry.description }
      : {}),
    ...(entry.accessInstructions !== undefined
      ? { accessInstructions: entry.accessInstructions }
      : {}),
  };
}

export interface CatalogueRepository {
  create(
    input: CatalogueEntryInput,
    adminUserId: UserId,
  ): Promise<CatalogueEntry>;
  /**
   * Update ONLY human-facing metadata (display name / description / access
   * instructions). Never mutates the alias or the upstream-agent mapping.
   */
  updateMetadata(
    id: string,
    patch: CatalogueEntryMetadataPatch,
    adminUserId: UserId,
  ): Promise<CatalogueEntry | undefined>;
  publish(id: string, adminUserId: UserId): Promise<CatalogueEntry | undefined>;
  unpublish(
    id: string,
    adminUserId: UserId,
  ): Promise<CatalogueEntry | undefined>;
  listAll(): Promise<readonly CatalogueEntry[]>;
  listPublished(): Promise<readonly PublicModel[]>;
  resolvePublishedAlias(alias: string): Promise<{ catalogueEntryId: string; upstreamAgentId: string } | undefined>;
}

// ---------------------------------------------------------------------------
// S5 — Server-side Sculpin discovery (parsing only; NO I/O here)
//
// The Hub discovers the upstream Sculpin agents by calling Sculpin's OpenAI
// `GET /v1/models` (docs/SCULPIN_INTEGRATION.md §1, §4). Per that contract each
// agent is emitted TWICE — once keyed by its human-friendly, RENAME-ABLE `slug`
// and once by its STABLE `id` UUID — and `owned_by` is the literal `"exodus"`.
//
// PAIRING SAFETY (the riskiest correctness call). The ModelList `data` rows are
// FLAT `{ id, object, owned_by, created? }` records; the contract carries NO
// field that links a slug row to its UUID row for the same agent. We therefore
// CANNOT reconstruct the slug↔uuid pairing from the response alone, and we
// deliberately DO NOT guess one: a wrong guess could silently map a public alias
// onto a REPLACEMENT upstream agent, which the mission forbids. Instead we surface
// EACH id as its own {@link DiscoveredAgent}, classify it as uuid-form or
// slug-form, and let the catalogue-admin layer prefer UUID-form entries as
// stable catalogue targets (STABLE-ALIAS RULE). `agentId` is the STABLE id to
// store as `upstreamAgentId`: the UUID itself for uuid-form rows; for slug-form
// rows there is no stable id available, so `agentId` falls back to the slug and
// `isUuid` is false so callers can fail closed / require a UUID target.
// ---------------------------------------------------------------------------

/**
 * A single agent id discovered from Sculpin's `GET /v1/models`. Because the
 * upstream response gives no explicit slug↔uuid link, this represents ONE id
 * row, not a reconstructed agent pair.
 *
 *  - `id`:      the raw id string exactly as Sculpin emitted it.
 *  - `agentId`: the value to persist as `upstreamAgentId`. Equal to `id`. For a
 *              uuid-form row this is the STABLE agent UUID (preferred target);
 *              for a slug-form row it is the rename-able slug (unstable — callers
 *              should prefer a uuid-form row when both exist for the same agent).
 *  - `isUuid`:  true when `id` is a well-formed UUID (the stable form).
 *  - `ownedBy`: the upstream `owned_by` value (expected `"exodus"`).
 */
export interface DiscoveredAgent {
  readonly id: string;
  readonly agentId: string;
  readonly isUuid: boolean;
  readonly ownedBy: string;
}

// Strict RFC-4122-shaped UUID (any version/variant hex layout). Case-insensitive
// because Sculpin may emit either case; classification only, never trusted for
// authz.
const discoveredUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RawModelRow {
  readonly id: unknown;
  readonly object?: unknown;
  readonly owned_by?: unknown;
}

/**
 * Parse Sculpin's OpenAI `GET /v1/models` body into discovered agent id rows.
 *
 * Fail-closed: throws {@link DomainValidationError} on any payload that is not a
 * well-formed non-empty `{ object: "list", data: [{ id, ... }] }` ModelList, or
 * any row whose `id` is not a non-empty string. Duplicate ids collapse to the
 * first occurrence. The result preserves upstream order.
 *
 * The returned rows are NOT paired (see the module note): each id is surfaced on
 * its own, classified via `isUuid`. Callers that need a stable catalogue target
 * should prefer `isUuid === true` rows.
 */
export function parseDiscoveredAgents(
  modelListJson: unknown,
): readonly DiscoveredAgent[] {
  if (!modelListJson || typeof modelListJson !== "object")
    throw new DomainValidationError(
      "Sculpin models response must be a JSON object.",
    );
  const body = modelListJson as { object?: unknown; data?: unknown };
  if (body.object !== "list")
    throw new DomainValidationError(
      "Sculpin models response must have object === 'list'.",
    );
  if (!Array.isArray(body.data))
    throw new DomainValidationError(
      "Sculpin models response `data` must be an array.",
    );
  if (body.data.length === 0)
    throw new DomainValidationError(
      "Sculpin models response `data` must not be empty.",
    );
  const seen = new Set<string>();
  const agents: DiscoveredAgent[] = [];
  for (const rawRow of body.data as unknown[]) {
    if (!rawRow || typeof rawRow !== "object")
      throw new DomainValidationError(
        "Sculpin models response contains a non-object entry.",
      );
    const row = rawRow as RawModelRow;
    if (typeof row.id !== "string" || row.id.length === 0)
      throw new DomainValidationError(
        "Sculpin models response entry `id` must be a non-empty string.",
      );
    const id = row.id;
    if (seen.has(id)) continue;
    seen.add(id);
    const ownedBy = typeof row.owned_by === "string" ? row.owned_by : "";
    agents.push({
      id,
      agentId: id,
      isUuid: discoveredUuidPattern.test(id),
      ownedBy,
    });
  }
  return agents;
}

/**
 * The set of STABLE upstream agent ids discoverable right now — the UUID-form
 * rows only. This is the authoritative set the catalogue-admin layer validates a
 * chosen `upstreamAgentId` against (create-from-discovered) and diffs published
 * entries against (drift). Returned as a `Set` for O(1) membership; the callers
 * never expose it to non-admins.
 */
export function stableDiscoveredAgentIds(
  agents: readonly DiscoveredAgent[],
): ReadonlySet<string> {
  return new Set(agents.filter((agent) => agent.isUuid).map((agent) => agent.agentId));
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

/**
 * Validate a partial plan mutation (the safe, mutable fields). Mirrors the
 * relevant bounds in {@link validatePlanInput} but only for fields present on
 * the patch, so an admin edit can never write an out-of-range quota/duration, a
 * too-long name/description, a control-character-laden string, or a non-boolean
 * policy flag. `key` and `kind` are intentionally NOT patchable (identity /
 * snapshot-affecting), so they are absent from {@link PlanPatch} and here.
 */
export function validatePlanPatch(patch: PlanPatch): void {
  if (patch.name !== undefined) {
    if (
      typeof patch.name !== "string" ||
      patch.name.length < 1 ||
      patch.name.length > 120 ||
      !displayNamePattern.test(patch.name)
    )
      throw new DomainValidationError(
        "Plan name must be non-empty and at most 120 characters.",
      );
  }
  if (patch.description !== undefined) {
    if (
      typeof patch.description !== "string" ||
      patch.description.length > 2048 ||
      controlCharPattern.test(patch.description)
    )
      throw new DomainValidationError(
        "Plan description must be at most 2048 characters with no control characters.",
      );
  }
  if (
    patch.durationDays !== undefined &&
    patch.durationDays !== null &&
    (!Number.isInteger(patch.durationDays) ||
      patch.durationDays < 1 ||
      patch.durationDays > 3650)
  )
    throw new DomainValidationError(
      "Plan duration must be an integer number of days between 1 and 3650.",
    );
  if (
    patch.requestQuota !== undefined &&
    (!Number.isInteger(patch.requestQuota) ||
      patch.requestQuota < 0 ||
      patch.requestQuota > 1_000_000)
  )
    throw new DomainValidationError(
      "Plan request quota must be an integer between 0 and 1000000.",
    );
  for (const flag of [
    "selfServiceEligible",
    "adminGrantable",
    "oneTimePerOrganization",
  ] as const) {
    if (patch[flag] !== undefined && typeof patch[flag] !== "boolean")
      throw new DomainValidationError(`Plan ${flag} must be a boolean.`);
  }
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
 * subscription WHOSE FROZEN SNAPSHOT GRANTS the requested offering
 * (`UsageContext.catalogueEntryId`). `remainingQuota` is the budget still
 * available FOR THAT OFFERING — pooled across the tenant's active subscriptions
 * that grant it, and 0 when none can serve it. Quota held by subscriptions that
 * do not grant the requested offering is never counted and never usable.
 */
export interface QuotaReservation {
  readonly granted: boolean;
  readonly remainingQuota: number;
}

/**
 * The per-request context recorded ALONGSIDE a granted quota reservation as a
 * usage event (S13/M7, D-023). It carries ONLY safe correlation identifiers — no
 * secret, prompt, request/response body, raw PAT, OAuth token, or upstream key
 * (CLAUDE.md rule 5). `patId` is the PAT ROW id, never the token secret.
 */
export interface UsageContext {
  readonly catalogueEntryId: string;
  readonly patId: string;
  readonly requestId: string;
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
   * Atomically reserve `amount` of request quota for the offering identified by
   * `usage.catalogueEntryId`, drawing ONLY from the tenant's active, in-window
   * subscriptions whose FROZEN snapshot grants that offering (pooling across
   * several such subscriptions when present). Quota from subscriptions that do
   * not grant the requested offering is never usable. MUST be a single
   * conditional UPDATE (no read-compare-write) so concurrent last-quota attempts
   * cannot over-draw. ON GRANT (and never on denial) it ALSO records a
   * `usage_events` row from `usage` in the SAME transaction as the quota UPDATE,
   * so quota and usage commit together or neither, and the event's
   * subscription_id always identifies a subscription whose snapshot contains the
   * recorded catalogue_entry_id (S13/M7, D-023). `usage` carries no
   * secret/prompt/body.
   */
  reserveQuota(
    organizationId: OrganizationId,
    amount: number,
    usage: UsageContext,
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

/** Max catalogue-entry scopes a single PAT may name (fail-closed upper bound). */
export const PAT_MAX_SCOPES = 100;

const patScopeUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate the requested PAT scope catalogue-entry ids. Scopes are IMMUTABLE and
 * set ONLY at mint. Each id must be a well-formed uuid; the list must be free of
 * duplicates and bounded by {@link PAT_MAX_SCOPES}. This is a pure shape check;
 * EXISTENCE against `catalogue_entries` is enforced atomically in the mint
 * transaction (db/pat.ts). An empty list is valid and means "unscoped" (inherit
 * the principal's full current entitlement).
 */
export function validatePatScopeIds(ids: readonly string[]): void {
  if (!Array.isArray(ids))
    throw new DomainValidationError("PAT scopes must be an array.");
  if (ids.length > PAT_MAX_SCOPES)
    throw new DomainValidationError(
      `A PAT may name at most ${PAT_MAX_SCOPES} catalogue scopes.`,
    );
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string" || !patScopeUuidPattern.test(id))
      throw new DomainValidationError(
        "PAT scope catalogue-entry ids must be uuids.",
      );
    if (seen.has(id))
      throw new DomainValidationError("PAT scopes must not contain duplicates.");
    seen.add(id);
  }
}

/**
 * Narrow a principal's entitled catalogue-entry ids by a PAT's immutable scopes
 * ("a PAT can only narrow"). Pure and composable — the seam a later milestone
 * (S8) further intersects with the published catalogue + available quota.
 *
 *  - empty `patScopes` → return `entitledCatalogueEntryIds` unchanged (unscoped =
 *    full principal entitlement);
 *  - otherwise → the SORTED intersection. A scope naming an entry the principal
 *    is not entitled to simply drops out, so a PAT can never grant MORE than the
 *    principal has (fail-closed).
 */
export function narrowOfferingsToPatScopes(
  patScopes: readonly string[],
  entitledCatalogueEntryIds: readonly string[],
): readonly string[] {
  if (patScopes.length === 0) return entitledCatalogueEntryIds;
  const entitled = new Set(entitledCatalogueEntryIds);
  return [...new Set(patScopes.filter((id) => entitled.has(id)))].sort();
}

/**
 * The catalogue-entry ids a caller may access RIGHT NOW, as an O(1)-membership
 * set: the caller's active-subscription offerings narrowed by the PAT's immutable
 * scopes (a PAT can only narrow). The data plane intersects this with the
 * PUBLISHED catalogue at resolve time. Fail-closed: no active offerings (or a PAT
 * whose scopes name nothing entitled) yields an EMPTY set — a valid credential
 * alone authorizes no model.
 */
export function authorizedCatalogueEntryIds(
  entitledCatalogueEntryIds: readonly string[],
  patScopes: readonly string[],
): ReadonlySet<string> {
  return new Set(
    narrowOfferingsToPatScopes(patScopes, entitledCatalogueEntryIds),
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
  /**
   * Immutable catalogue-entry scopes set at mint. EMPTY means "unscoped" —
   * inherit the principal's full current entitlement. A non-empty list narrows
   * the PAT to exactly those catalogue entries (a PAT can only narrow).
   */
  readonly scopes: readonly string[];
}

/** Resolved caller identity after a successful PAT authentication. */
export interface PatIdentity {
  readonly patId: string;
  readonly userId: UserId;
  readonly organizationId: OrganizationId;
  /**
   * The PAT's immutable catalogue-entry scopes (empty = unscoped). S8 intersects
   * these with the active-subscription offerings and published catalogue.
   */
  readonly scopes: readonly string[];
}

/** A freshly minted PAT: the record plus the ONE-TIME raw token to display. */
export interface MintedPat {
  readonly record: PatRecord;
  readonly token: string;
}
