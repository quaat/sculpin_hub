import type { Metadata } from "next";
import Link from "next/link";
import { ensureAdminPage } from "../admin-gate";
import { ActionForm } from "../action-form";
import { grantPlanAction, setSubscriptionStatusAction } from "../actions";

export const metadata: Metadata = { title: "Admin · Subscriptions" };
export const dynamic = "force-dynamic";

/**
 * Admin subscription management. There is no cross-tenant subscription LISTING
 * lib function in S6, so this surface provides the two supported mutations by
 * id: grant a plan to an organization, and transition a subscription's status.
 * Both actions are re-authorized server-side via `requireAdmin`.
 */
export default async function AdminSubscriptions() {
  await ensureAdminPage();
  return (
    <main id="main">
      <section className="page-hero">
        <p className="eyebrow">Administration</p>
        <h1>Subscriptions</h1>
        <p className="lede">
          Grant a plan to an organization or change a subscription&rsquo;s
          status. An admin grant may use any enabled plan, including
          non-self-service ones.
        </p>
      </section>

      <section aria-labelledby="grant-heading">
        <div className="section-heading">
          <h2 id="grant-heading">Grant a plan</h2>
        </div>
        <ActionForm
          action={grantPlanAction}
          submitLabel="Grant plan"
          pendingLabel="Granting…"
          className="admin-form stacked"
        >
          <label>
            Organization id (uuid)
            <input type="text" name="organizationId" required />
          </label>
          <label>
            Plan id (uuid)
            <input type="text" name="planId" required />
          </label>
        </ActionForm>
      </section>

      <section aria-labelledby="status-heading">
        <div className="section-heading">
          <h2 id="status-heading">Change subscription status</h2>
        </div>
        <ActionForm
          action={setSubscriptionStatusAction}
          submitLabel="Update status"
          pendingLabel="Updating…"
          className="admin-form stacked"
        >
          <label>
            Subscription id (uuid)
            <input type="text" name="subscriptionId" required />
          </label>
          <label>
            Status
            <select name="status" required defaultValue="active">
              <option value="active">active</option>
              <option value="suspended">suspended</option>
              <option value="canceled">canceled</option>
              <option value="expired">expired</option>
            </select>
          </label>
        </ActionForm>
      </section>

      <section aria-labelledby="usage-audit">
        <h2 id="usage-audit">Usage &amp; audit</h2>
        <p>
          Subscription grants and status changes are recorded as audit events.
          Review them alongside aggregate usage on the{" "}
          <Link className="text-link" href="/admin/audit">
            Audit &amp; usage
          </Link>{" "}
          view.
        </p>
      </section>
    </main>
  );
}
