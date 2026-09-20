"use client";

import { useActionState } from "react";
import type { ReactNode } from "react";
import type { ActionResult } from "./actions";

/**
 * Small reusable client wrapper around an admin server action. It renders the
 * supplied form fields, a submit button, and the action's stable, secret-free
 * result message. It holds no authorization state and no secrets — the server
 * action re-authorizes via `requireAdmin` on every submit.
 */
type ServerAction = (formData: FormData) => Promise<ActionResult>;

async function run(
  action: ServerAction,
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return action(formData);
}

export function ActionForm({
  action,
  submitLabel,
  pendingLabel,
  className,
  children,
}: {
  readonly action: ServerAction;
  readonly submitLabel: string;
  readonly pendingLabel?: string;
  readonly className?: string;
  readonly children?: ReactNode;
}) {
  const [state, formAction, pending] = useActionState<
    ActionResult | null,
    FormData
  >((previous, formData) => run(action, previous, formData), null);
  return (
    <form action={formAction} className={className ?? "admin-form"}>
      {children}
      <button type="submit" className="button small" disabled={pending}>
        {pending ? (pendingLabel ?? "Working…") : submitLabel}
      </button>
      {state ? (
        <span
          className={state.ok ? "form-ok" : "form-error"}
          role="status"
        >
          {state.message}
        </span>
      ) : null}
    </form>
  );
}
