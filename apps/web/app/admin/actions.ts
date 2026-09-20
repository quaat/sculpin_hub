"use server";

import { revalidatePath } from "next/cache";
import {
  DomainConflictError,
  DomainValidationError,
  type PlanInput,
  type PlanKind,
  type PlanPatch,
  type SubscriptionStatus,
} from "@sculpin/domain";
import { AuthzError } from "../lib/session";
import {
  CatalogueInputError,
  UndiscoverableAgentError,
  createCatalogueEntryFromDiscovered,
  publishCatalogueEntry,
  unpublishCatalogueEntry,
} from "../lib/catalogue";
import { DiscoveryError } from "../lib/discovery";
import {
  PlanAdminInputError,
  attachPlanCatalogueEntry,
  createPlan,
  detachPlanCatalogueEntry,
  setPlanEnabled,
  setPlanPublished,
  updatePlan,
} from "../lib/plan-admin";
import {
  AdminGrantError,
  SubscriptionInputError,
  adminGrantPlan,
  adminSetSubscriptionStatus,
} from "../lib/subscription";

/**
 * Admin server actions (S6). Every underlying lib call is gated by
 * `requireAdmin`, which re-derives the platform role from the canonical `users`
 * row (never the session) — so these actions can never be used by a non-admin
 * even if the client were tampered with. Each action maps outcomes to a stable,
 * secret-free message; the upstream URL, credential, and internal agent ids are
 * never surfaced (discovery/catalogue errors carry machine reasons only).
 */
export type ActionResult =
  | { readonly ok: true; readonly message?: string }
  | { readonly ok: false; readonly message: string };

const PLAN_KINDS: readonly PlanKind[] = [
  "free_trial",
  "commercial_monthly",
  "commercial_annual",
];

const SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = [
  "active",
  "suspended",
  "canceled",
  "expired",
];

function forbiddenOrError(error: unknown): ActionResult | undefined {
  if (error instanceof AuthzError) {
    return { ok: false, message: "You are not authorized to do that." };
  }
  if (error instanceof DomainValidationError) {
    return { ok: false, message: "The submitted values are not valid." };
  }
  return undefined;
}

function str(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

// --- Catalogue ------------------------------------------------------------

export async function publishCatalogueAction(
  formData: FormData,
): Promise<ActionResult> {
  const id = str(formData, "id");
  try {
    await publishCatalogueEntry(id);
    revalidatePath("/admin/catalogue");
    return { ok: true, message: "Published." };
  } catch (error) {
    if (error instanceof CatalogueInputError) {
      return { ok: false, message: "Invalid catalogue entry id." };
    }
    return forbiddenOrError(error) ?? { ok: false, message: "Unable to publish." };
  }
}

export async function unpublishCatalogueAction(
  formData: FormData,
): Promise<ActionResult> {
  const id = str(formData, "id");
  try {
    await unpublishCatalogueEntry(id);
    revalidatePath("/admin/catalogue");
    return { ok: true, message: "Unpublished." };
  } catch (error) {
    if (error instanceof CatalogueInputError) {
      return { ok: false, message: "Invalid catalogue entry id." };
    }
    return (
      forbiddenOrError(error) ?? { ok: false, message: "Unable to unpublish." }
    );
  }
}

// --- Discovery-driven catalogue creation ----------------------------------

export async function createFromDiscoveredAction(
  formData: FormData,
): Promise<ActionResult> {
  const publicAlias = str(formData, "publicAlias");
  const displayName = str(formData, "displayName");
  const description = str(formData, "description");
  const upstreamAgentId = str(formData, "upstreamAgentId");
  try {
    await createCatalogueEntryFromDiscovered({
      publicAlias,
      displayName,
      upstreamAgentId,
      ...(description.length > 0 ? { description } : {}),
    });
    revalidatePath("/admin/catalogue");
    revalidatePath("/admin/discovery");
    return { ok: true, message: "Catalogue entry created." };
  } catch (error) {
    if (error instanceof UndiscoverableAgentError) {
      return {
        ok: false,
        message: "That agent is not currently discoverable upstream.",
      };
    }
    if (error instanceof DiscoveryError) {
      return { ok: false, message: "Discovery is unavailable right now." };
    }
    if (error instanceof DomainConflictError) {
      return { ok: false, message: "That public alias is already in use." };
    }
    return (
      forbiddenOrError(error) ?? {
        ok: false,
        message: "Unable to create the entry.",
      }
    );
  }
}

// --- Plans ----------------------------------------------------------------

export async function createPlanAction(
  formData: FormData,
): Promise<ActionResult> {
  const key = str(formData, "key");
  const name = str(formData, "name");
  const description = str(formData, "description");
  const kindRaw = str(formData, "kind");
  const requestQuotaRaw = str(formData, "requestQuota");
  const durationDaysRaw = str(formData, "durationDays");
  const selfServiceEligible = formData.get("selfServiceEligible") === "on";
  const adminGrantable = formData.get("adminGrantable") === "on";
  // A free_trial defaults to one-time-per-organization (enforced in the
  // repository), but the admin can still opt a plan in explicitly via this box.
  const oneTimePerOrganization =
    formData.get("oneTimePerOrganization") === "on";

  if (!PLAN_KINDS.includes(kindRaw as PlanKind)) {
    return { ok: false, message: "Choose a valid plan kind." };
  }
  // An empty field coerces via Number("") to 0; require it explicitly so a
  // direct server-action call (bypassing the browser `required`) cannot slip
  // through with a silent quota of 0.
  if (requestQuotaRaw.length === 0) {
    return { ok: false, message: "Request quota is required." };
  }
  const requestQuota = Number(requestQuotaRaw);
  if (!Number.isInteger(requestQuota)) {
    return { ok: false, message: "Request quota must be an integer." };
  }
  let durationDays: number | undefined;
  if (durationDaysRaw.length > 0) {
    const parsed = Number(durationDaysRaw);
    if (!Number.isInteger(parsed)) {
      return { ok: false, message: "Duration must be an integer number of days." };
    }
    durationDays = parsed;
  }

  const input: PlanInput = {
    key,
    name,
    kind: kindRaw as PlanKind,
    requestQuota,
    selfServiceEligible,
    adminGrantable,
    ...(oneTimePerOrganization ? { oneTimePerOrganization } : {}),
    ...(description.length > 0 ? { description } : {}),
    ...(durationDays !== undefined ? { durationDays } : {}),
  };
  try {
    await createPlan(input);
    revalidatePath("/admin/plans");
    return { ok: true, message: "Plan created." };
  } catch (error) {
    if (error instanceof DomainConflictError) {
      return { ok: false, message: "A plan with that key already exists." };
    }
    return (
      forbiddenOrError(error) ?? { ok: false, message: "Unable to create plan." }
    );
  }
}

/**
 * Edit a plan's SAFE mutable fields. `key` and `kind` are immutable (identity /
 * snapshot-affecting) and are never read here. This form is authoritative for
 * the fields it renders: the three policy checkboxes are always applied from
 * their submitted state, and an empty duration clears the window (null).
 */
export async function updatePlanAction(
  formData: FormData,
): Promise<ActionResult> {
  const id = str(formData, "id");
  const name = str(formData, "name");
  const description = str(formData, "description");
  const requestQuotaRaw = str(formData, "requestQuota");
  const durationDaysRaw = str(formData, "durationDays");

  if (requestQuotaRaw.length === 0) {
    return { ok: false, message: "Request quota is required." };
  }
  const requestQuota = Number(requestQuotaRaw);
  if (!Number.isInteger(requestQuota)) {
    return { ok: false, message: "Request quota must be an integer." };
  }
  let durationDays: number | null = null;
  if (durationDaysRaw.length > 0) {
    const parsed = Number(durationDaysRaw);
    if (!Number.isInteger(parsed)) {
      return { ok: false, message: "Duration must be an integer number of days." };
    }
    durationDays = parsed;
  }

  const patch: PlanPatch = {
    name,
    description,
    requestQuota,
    durationDays,
    selfServiceEligible: formData.get("selfServiceEligible") === "on",
    adminGrantable: formData.get("adminGrantable") === "on",
    oneTimePerOrganization: formData.get("oneTimePerOrganization") === "on",
  };
  try {
    const updated = await updatePlan(id, patch);
    revalidatePath("/admin/plans");
    if (!updated) return { ok: false, message: "Plan not found." };
    return { ok: true, message: "Plan updated." };
  } catch (error) {
    if (error instanceof PlanAdminInputError) {
      return { ok: false, message: "Invalid plan id." };
    }
    if (error instanceof DomainValidationError) {
      return { ok: false, message: error.message };
    }
    return forbiddenOrError(error) ?? { ok: false, message: "Unable to update plan." };
  }
}

export async function setPlanEnabledAction(
  formData: FormData,
): Promise<ActionResult> {
  const id = str(formData, "id");
  const enabled = str(formData, "enabled") === "true";
  try {
    await setPlanEnabled(id, enabled);
    revalidatePath("/admin/plans");
    return { ok: true, message: enabled ? "Enabled." : "Disabled." };
  } catch (error) {
    if (error instanceof PlanAdminInputError) {
      return { ok: false, message: "Invalid plan id." };
    }
    return forbiddenOrError(error) ?? { ok: false, message: "Unable to update." };
  }
}

export async function setPlanPublishedAction(
  formData: FormData,
): Promise<ActionResult> {
  const id = str(formData, "id");
  const published = str(formData, "published") === "true";
  try {
    await setPlanPublished(id, published);
    revalidatePath("/admin/plans");
    return { ok: true, message: published ? "Published." : "Unpublished." };
  } catch (error) {
    if (error instanceof PlanAdminInputError) {
      return { ok: false, message: "Invalid plan id." };
    }
    return forbiddenOrError(error) ?? { ok: false, message: "Unable to update." };
  }
}

export async function attachCatalogueEntryAction(
  formData: FormData,
): Promise<ActionResult> {
  const planId = str(formData, "planId");
  const catalogueEntryId = str(formData, "catalogueEntryId");
  try {
    await attachPlanCatalogueEntry(planId, catalogueEntryId);
    revalidatePath("/admin/plans");
    return { ok: true, message: "Attached." };
  } catch (error) {
    if (error instanceof PlanAdminInputError) {
      return { ok: false, message: "Invalid id." };
    }
    return forbiddenOrError(error) ?? { ok: false, message: "Unable to attach." };
  }
}

export async function detachCatalogueEntryAction(
  formData: FormData,
): Promise<ActionResult> {
  const planId = str(formData, "planId");
  const catalogueEntryId = str(formData, "catalogueEntryId");
  try {
    await detachPlanCatalogueEntry(planId, catalogueEntryId);
    revalidatePath("/admin/plans");
    return { ok: true, message: "Detached." };
  } catch (error) {
    if (error instanceof PlanAdminInputError) {
      return { ok: false, message: "Invalid id." };
    }
    return forbiddenOrError(error) ?? { ok: false, message: "Unable to detach." };
  }
}

// --- Subscriptions --------------------------------------------------------

export async function grantPlanAction(
  formData: FormData,
): Promise<ActionResult> {
  const organizationId = str(formData, "organizationId");
  const planId = str(formData, "planId");
  try {
    await adminGrantPlan({ organizationId, planId });
    revalidatePath("/admin/subscriptions");
    return { ok: true, message: "Plan granted." };
  } catch (error) {
    if (error instanceof DomainConflictError) {
      return { ok: false, message: "That plan is already claimed for this org." };
    }
    if (error instanceof AdminGrantError) {
      return {
        ok: false,
        message:
          error.reason === "plan_not_admin_grantable"
            ? "That plan is not admin-grantable."
            : "That plan is not available.",
      };
    }
    if (error instanceof SubscriptionInputError) {
      return { ok: false, message: "Invalid grant input." };
    }
    return forbiddenOrError(error) ?? { ok: false, message: "Unable to grant." };
  }
}

export async function setSubscriptionStatusAction(
  formData: FormData,
): Promise<ActionResult> {
  const subscriptionId = str(formData, "subscriptionId");
  const statusRaw = str(formData, "status");
  if (!SUBSCRIPTION_STATUSES.includes(statusRaw as SubscriptionStatus)) {
    return { ok: false, message: "Choose a valid status." };
  }
  try {
    const updated = await adminSetSubscriptionStatus({
      subscriptionId,
      status: statusRaw as SubscriptionStatus,
    });
    revalidatePath("/admin/subscriptions");
    if (!updated) {
      return { ok: false, message: "No change (illegal transition or not found)." };
    }
    return { ok: true, message: "Status updated." };
  } catch (error) {
    if (error instanceof SubscriptionInputError) {
      return { ok: false, message: "Invalid subscription id." };
    }
    return forbiddenOrError(error) ?? { ok: false, message: "Unable to update." };
  }
}
