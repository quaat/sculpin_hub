"use server";

import { revalidatePath } from "next/cache";
import { DomainConflictError } from "@sculpin/domain";
import { AuthzError } from "../lib/session";
import {
  SelfServiceClaimError,
  claimSelfServicePlanForCaller,
} from "../lib/subscription";

/**
 * Server action: claim a self-service plan for the SIGNED-IN caller's own
 * personal organization. Authorization + the enabled/published/self-service
 * gate are enforced inside `claimSelfServicePlanForCaller` (which itself calls
 * `requireOrganization`) — this action only maps the outcome to a stable,
 * secret-free message the page can render. Never trusts the client for the org
 * id; the caller's personal org is resolved server-side.
 */
export type ClaimResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

const CLAIM_MESSAGES: Record<string, string> = {
  plan_not_available: "That plan is no longer available.",
  plan_not_self_service: "That plan cannot be claimed directly.",
  plan_already_claimed: "You have already claimed this plan.",
  unauthenticated: "Please sign in to claim a plan.",
  organization_not_found: "Your account has no personal organization.",
};

function messageFor(reason: string): string {
  return CLAIM_MESSAGES[reason] ?? "Unable to claim that plan right now.";
}

export async function claimPlanAction(formData: FormData): Promise<ClaimResult> {
  const planId = formData.get("planId");
  if (typeof planId !== "string" || planId.length === 0) {
    return { ok: false, message: "A plan must be selected." };
  }
  try {
    await claimSelfServicePlanForCaller(planId);
    revalidatePath("/account");
    return { ok: true };
  } catch (error) {
    if (error instanceof SelfServiceClaimError) {
      return { ok: false, message: messageFor(error.reason) };
    }
    if (error instanceof DomainConflictError) {
      return { ok: false, message: messageFor(error.code) };
    }
    if (error instanceof AuthzError) {
      return { ok: false, message: messageFor(error.reason) };
    }
    throw error;
  }
}
