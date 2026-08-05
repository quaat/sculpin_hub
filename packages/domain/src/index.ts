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
    readonly code: "identity_conflict" | "organization_slug_conflict",
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
