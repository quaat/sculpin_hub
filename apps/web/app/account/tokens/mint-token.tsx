"use client";

import { useActionState, useState } from "react";
import { mintTokenAction, type MintResult } from "./actions";

/**
 * PAT mint form + ONE-TIME reveal (web-control-plane PAT hygiene).
 *
 * SECURITY: the raw token returned by the action lives ONLY in transient React
 * state for this render. It is NEVER written to localStorage/sessionStorage, a
 * persisted data-attribute, analytics, or the console. The value is shown once;
 * dismissing the reveal drops it from state (and it is not re-fetchable from the
 * server), so navigating away or refreshing loses it permanently — exactly the
 * intended "you will not see this again" behavior.
 */
async function runMint(
  _previous: MintResult | null,
  formData: FormData,
): Promise<MintResult> {
  return mintTokenAction(formData);
}

export function MintToken() {
  const [state, action, pending] = useActionState<MintResult | null, FormData>(
    runMint,
    null,
  );
  const [dismissed, setDismissed] = useState(false);
  const [copied, setCopied] = useState(false);

  const revealed = state?.ok && !dismissed ? state : null;

  async function copy(token: string) {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
    } catch {
      // Clipboard may be unavailable; the user can still select the text.
      setCopied(false);
    }
  }

  return (
    <div className="mint-token">
      <form action={action} className="mint-form">
        <label>
          Token name
          <input
            type="text"
            name="name"
            required
            maxLength={120}
            autoComplete="off"
            placeholder="e.g. laptop-cli"
          />
        </label>
        <label>
          Expires (optional)
          <input type="date" name="expiresAt" autoComplete="off" />
        </label>
        <button type="submit" className="button" disabled={pending}>
          {pending ? "Minting…" : "Mint token"}
        </button>
      </form>

      {state && !state.ok ? (
        <p className="form-error" role="status">
          {state.message}
        </p>
      ) : null}

      {revealed ? (
        <div className="token-reveal" role="alert">
          <h3>Copy your token now</h3>
          <p className="token-warning">
            <strong>This is the only time you will see this token.</strong> It
            is not stored and cannot be recovered. If you lose it, revoke it and
            mint a new one.
          </p>
          <p className="token-value">
            {/* Rendered as text only; not placed in any persisted attribute. */}
            <code>{revealed.token}</code>
          </p>
          <div className="token-actions">
            <button
              type="button"
              className="button small"
              onClick={() => void copy(revealed.token)}
            >
              {copied ? "Copied" : "Copy"}
            </button>
            <button
              type="button"
              className="button small secondary"
              onClick={() => {
                setDismissed(true);
                setCopied(false);
              }}
            >
              I have saved it
            </button>
          </div>
          <p className="muted">
            Token <code>{revealed.publicId}</code> ({revealed.name}) is now
            listed below by its public id only.
          </p>
        </div>
      ) : null}
    </div>
  );
}
