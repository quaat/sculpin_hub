"use client";

import { useActionState } from "react";
import { revokeTokenAction, type RevokeResult } from "./actions";

/**
 * Per-token revoke control. Revocation is server-authoritative and idempotent;
 * the list is revalidated by the action so the UI reflects the change
 * immediately. Carries no secret — only the opaque token id.
 */
async function runRevoke(
  _previous: RevokeResult | null,
  formData: FormData,
): Promise<RevokeResult> {
  return revokeTokenAction(formData);
}

export function RevokeToken({ id }: { readonly id: string }) {
  const [state, action, pending] = useActionState<RevokeResult | null, FormData>(
    runRevoke,
    null,
  );
  return (
    <form action={action} className="revoke-form">
      <input type="hidden" name="id" value={id} />
      <button type="submit" className="button small secondary" disabled={pending}>
        {pending ? "Revoking…" : "Revoke"}
      </button>
      {state && !state.ok ? (
        <span className="form-error" role="status">
          {state.message}
        </span>
      ) : null}
    </form>
  );
}
