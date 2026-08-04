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
export type MembershipStatus = "active" | "inactive";
export type MembershipRole = "owner" | "member";

export interface ExternalIdentityInput {
  readonly provider: string;
  readonly providerSubject: string;
  readonly providerEmail?: string;
  readonly emailVerified: boolean;
  readonly claims?: Readonly<Record<string, string | boolean | number | null>>;
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

export interface PersonalTenantTransaction {
  create(command: CreatePersonalTenantCommand): Promise<PersonalTenantResult>;
}

export class CreatePersonalTenantService {
  constructor(private readonly transactions: PersonalTenantTransaction) {}

  execute(command: CreatePersonalTenantCommand): Promise<PersonalTenantResult> {
    if (
      command.normalizedEmail !== command.normalizedEmail.trim().toLowerCase()
    )
      throw new DomainValidationError("Email must already be normalized.");
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(command.organizationSlug))
      throw new DomainValidationError("Organization slug is invalid.");
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
