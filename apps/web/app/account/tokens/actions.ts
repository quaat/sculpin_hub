"use server";

import { revalidatePath } from "next/cache";
import { DomainValidationError } from "@sculpin/domain";
import { AuthzError } from "../../lib/session";
import {
  PatInputError,
  createPersonalAccessToken,
  revokePersonalAccessToken,
} from "../../lib/pat";

/**
 * PAT server actions (CLAUDE.md rule 2 / web-control-plane PAT hygiene).
 *
 * `mintTokenAction` returns the raw token EXACTLY ONCE, in the action result, so
 * a client component can display it a single time. The raw token is NEVER
 * persisted server-side beyond this response, never logged, and is not
 * re-fetchable — `listPersonalAccessTokens` only ever returns metadata. The
 * caller identity and personal-org resolution happen inside the lib function.
 */
export type MintResult =
  | {
      readonly ok: true;
      readonly token: string;
      readonly publicId: string;
      readonly name: string;
    }
  | { readonly ok: false; readonly message: string };

export type RevokeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

const AUTH_MESSAGES: Record<string, string> = {
  unauthenticated: "Please sign in to manage tokens.",
  organization_not_found: "Your account has no personal organization.",
  user_inactive: "Your account is not active.",
};

function authMessage(reason: string): string {
  return AUTH_MESSAGES[reason] ?? "Unable to complete that action right now.";
}

export async function mintTokenAction(formData: FormData): Promise<MintResult> {
  const rawName = formData.get("name");
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (name.length === 0) {
    return { ok: false, message: "A token name is required." };
  }

  const rawExpiry = formData.get("expiresAt");
  let expiresAt: Date | undefined;
  if (typeof rawExpiry === "string" && rawExpiry.length > 0) {
    const parsed = new Date(rawExpiry);
    if (Number.isNaN(parsed.getTime())) {
      return { ok: false, message: "The expiry date is invalid." };
    }
    if (parsed.getTime() <= Date.now()) {
      return { ok: false, message: "The expiry date must be in the future." };
    }
    expiresAt = parsed;
  }

  try {
    const minted = await createPersonalAccessToken({
      name,
      ...(expiresAt ? { expiresAt } : {}),
    });
    revalidatePath("/account/tokens");
    // The raw token crosses the wire once, to be shown once; it is not stored.
    return {
      ok: true,
      token: minted.token,
      publicId: minted.record.publicId,
      name: minted.record.name,
    };
  } catch (error) {
    if (error instanceof DomainValidationError) {
      return { ok: false, message: "That token name is not allowed." };
    }
    if (error instanceof AuthzError) {
      return { ok: false, message: authMessage(error.reason) };
    }
    throw error;
  }
}

export async function revokeTokenAction(
  formData: FormData,
): Promise<RevokeResult> {
  const id = formData.get("id");
  if (typeof id !== "string" || id.length === 0) {
    return { ok: false, message: "A token must be selected." };
  }
  try {
    await revokePersonalAccessToken(id);
    revalidatePath("/account/tokens");
    return { ok: true };
  } catch (error) {
    if (error instanceof PatInputError) {
      return { ok: false, message: "That token id is invalid." };
    }
    if (error instanceof AuthzError) {
      return { ok: false, message: authMessage(error.reason) };
    }
    throw error;
  }
}
