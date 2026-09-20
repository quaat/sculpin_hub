import Link from "next/link";
import type { Entitlement, Plan, Subscription } from "@sculpin/domain";
import { ClaimPlanForm } from "./claim-plan-form";

/**
 * Presentational account/subscription view (pure; no I/O). Renders the caller's
 * entitlement summary, their subscriptions, and the self-service plans they may
 * claim. Extracted so it can be unit-tested with injected props (no DB / no
 * session). Shows no secrets and no internal ids beyond opaque plan keys the
 * user already owns.
 */
function formatDate(value?: Date): string {
  if (!value) return "—";
  return value.toISOString().slice(0, 10);
}

export function AccountView({
  entitlement,
  subscriptions,
  plans,
}: {
  readonly entitlement: Entitlement;
  readonly subscriptions: readonly Subscription[];
  readonly plans: readonly Plan[];
}) {
  return (
    <main id="main">
      <section className="page-hero">
        <p className="eyebrow">Account</p>
        <h1>Your subscription</h1>
        <p className="lede">
          Review your entitlement and manage subscriptions. Mint API access on
          the <Link href="/account/tokens">Tokens</Link> page.
        </p>
      </section>

      <section aria-labelledby="entitlement-heading">
        <div className="section-heading">
          <h2 id="entitlement-heading">Entitlement</h2>
        </div>
        <div className="cards">
          <article className="card">
            <h3>Status</h3>
            <p>{entitlement.active ? "Active" : "No active subscription"}</p>
          </article>
          <article className="card">
            <h3>Remaining quota</h3>
            <p>{entitlement.remainingQuota}</p>
          </article>
          <article className="card">
            <h3>Plans</h3>
            <p>
              {entitlement.planKeys.length > 0
                ? entitlement.planKeys.join(", ")
                : "None"}
            </p>
          </article>
        </div>
      </section>

      <section aria-labelledby="subscriptions-heading">
        <div className="section-heading">
          <h2 id="subscriptions-heading">Subscriptions</h2>
        </div>
        {subscriptions.length === 0 ? (
          <p className="muted">You have no subscriptions yet.</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Plan</th>
                <th scope="col">Kind</th>
                <th scope="col">Status</th>
                <th scope="col">Quota (used / limit)</th>
                <th scope="col">Ends</th>
              </tr>
            </thead>
            <tbody>
              {subscriptions.map((subscription) => (
                <tr key={subscription.id}>
                  <td>{subscription.planKey}</td>
                  <td>{subscription.planKind}</td>
                  <td>{subscription.status}</td>
                  <td>
                    {subscription.quotaUsed} / {subscription.quotaLimit}
                  </td>
                  <td>{formatDate(subscription.endsAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="plans-heading">
        <div className="section-heading">
          <h2 id="plans-heading">Available plans</h2>
        </div>
        {plans.length === 0 ? (
          <p className="muted">No self-service plans are available.</p>
        ) : (
          <div className="cards">
            {plans.map((plan) => (
              <article className="card" key={plan.id}>
                <span className="tag">{plan.kind}</span>
                <h3>{plan.name}</h3>
                {plan.description ? <p>{plan.description}</p> : null}
                <p className="muted">Request quota: {plan.requestQuota}</p>
                <ClaimPlanForm planId={plan.id} planName={plan.name} />
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
