"use server";

import { revalidatePath } from "next/cache";
import { DomainValidationError } from "@sculpin/domain";
import { AuthzError } from "../../lib/session";
import {
  PatInputError,
  createPersonalAccessToken,
  revokePersonalAccessToken,
} from "../../lib/pat";
import { resolveScopableOfferings } from "../../lib/pat-scopes";

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

  // Scope is an EXPLICIT choice. An omitted / unknown mode fails closed rather
  // than silently minting an unscoped (full-entitlement) token. "all" = unscoped
  // (inherits the caller's full entitlement at request time); "selected" =
  // narrow to the chosen offerings, which must be BOTH published AND entitled.
  const scopeMode = formData.get("scopeMode");
  let scopeCatalogueEntryIds: readonly string[] | undefined;
  if (scopeMode === "all") {
    scopeCatalogueEntryIds = undefined;
  } else if (scopeMode === "selected") {
    const selectedAliases = formData
      .getAll("scopeAlias")
      .filter((value): value is string => typeof value === "string");
    if (selectedAliases.length === 0) {
      return {
        ok: false,
        message:
          "Select at least one offering to scope to, or choose all entitled offerings.",
      };
    }
    let scopable: readonly { catalogueEntryId: string; publicAlias: string }[];
    try {
      scopable = await resolveScopableOfferings();
    } catch (error) {
      if (error instanceof AuthzError) {
        return { ok: false, message: authMessage(error.reason) };
      }
      throw error;
    }
    // Re-resolve alias → immutable scope id against the caller's live
    // published+entitled set. A submitted alias not in that set (unknown,
    // unpublished, or not entitled) is REJECTED — a client can never forge a
    // scope for an offering it may not use.
    const aliasToId = new Map(
      scopable.map((offering) => [offering.publicAlias, offering.catalogueEntryId]),
    );
    const ids = new Set<string>();
    for (const alias of selectedAliases) {
      const id = aliasToId.get(alias);
      if (!id) {
        return {
          ok: false,
          message: "One or more selected offerings are not available to you.",
        };
      }
      ids.add(id);
    }
    scopeCatalogueEntryIds = [...ids];
  } else {
    return { ok: false, message: "Choose how to scope this token." };
  }

  try {
    const minted = await createPersonalAccessToken({
      name,
      ...(expiresAt ? { expiresAt } : {}),
      ...(scopeCatalogueEntryIds !== undefined ? { scopeCatalogueEntryIds } : {}),
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
