"use client";

import { useActionState } from "react";
import { claimPlanAction, type ClaimResult } from "./actions";

/**
 * Minimal client form that submits a self-service plan claim. It carries no
 * secrets and no authorization state — the server action re-derives the caller
 * and enforces every gate. The friendly `message` returned by the action is the
 * only thing rendered on failure (a stable, secret-free reason).
 */
async function runClaim(
  _previous: ClaimResult | null,
  formData: FormData,
): Promise<ClaimResult> {
  return claimPlanAction(formData);
}

export function ClaimPlanForm({
  planId,
  planName,
}: {
  readonly planId: string;
  readonly planName: string;
}) {
  const [state, action, pending] = useActionState<ClaimResult | null, FormData>(
    runClaim,
    null,
  );
  return (
    <form action={action} className="claim-form">
      <input type="hidden" name="planId" value={planId} />
      <button type="submit" className="button small" disabled={pending}>
        {pending ? "Claiming…" : `Claim ${planName}`}
      </button>
      {state && !state.ok ? (
        <p className="form-error" role="status">
          {state.message}
        </p>
      ) : null}
      {state?.ok ? (
        <p className="form-ok" role="status">
          Claimed. Your entitlement is updated.
        </p>
      ) : null}
    </form>
  );
}
