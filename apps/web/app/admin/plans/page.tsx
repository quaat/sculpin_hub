import type { Metadata } from "next";
import { listPlansForAdmin } from "../../lib/plan-admin";
import { ensureAdminPage } from "../admin-gate";
import { ActionForm } from "../action-form";
import {
  attachCatalogueEntryAction,
  createPlanAction,
  detachCatalogueEntryAction,
  setPlanEnabledAction,
  setPlanPublishedAction,
} from "../actions";

export const metadata: Metadata = { title: "Admin · Plans" };
export const dynamic = "force-dynamic";

export default async function AdminPlans() {
  await ensureAdminPage();
  const plans = await listPlansForAdmin();
  return (
    <main id="main">
      <section className="page-hero">
        <p className="eyebrow">Administration</p>
        <h1>Plans</h1>
        <p className="lede">
          Create plans and manage their catalogue mapping. Self-service claims
          require a plan that is enabled, published, and self-service eligible.
        </p>
      </section>

      <section aria-labelledby="create-plan-heading">
        <div className="section-heading">
          <h2 id="create-plan-heading">Create a plan</h2>
        </div>
        <ActionForm
          action={createPlanAction}
          submitLabel="Create plan"
          pendingLabel="Creating…"
          className="admin-form stacked"
        >
          <label>
            Key
            <input type="text" name="key" required maxLength={63} />
          </label>
          <label>
            Name
            <input type="text" name="name" required maxLength={120} />
          </label>
          <label>
            Description (optional)
            <input type="text" name="description" maxLength={2048} />
          </label>
          <label>
            Kind
            <select name="kind" required defaultValue="free_trial">
              <option value="free_trial">free_trial</option>
              <option value="commercial_monthly">commercial_monthly</option>
              <option value="commercial_annual">commercial_annual</option>
            </select>
          </label>
          <label>
            Request quota
            <input type="number" name="requestQuota" required min={0} step={1} />
          </label>
          <label>
            Duration (days, optional)
            <input type="number" name="durationDays" min={1} step={1} />
          </label>
          <label className="checkbox">
            <input type="checkbox" name="selfServiceEligible" /> Self-service
            eligible
          </label>
        </ActionForm>
      </section>

      <section aria-label="Existing plans">
        <div className="section-heading">
          <h2>Existing plans</h2>
        </div>
        {plans.length === 0 ? (
          <p className="muted">No plans yet.</p>
        ) : (
          <div className="cards">
            {plans.map((plan) => (
              <article className="card" key={plan.id}>
                <span className="tag">{plan.kind}</span>
                <h3>{plan.name}</h3>
                <p className="muted">
                  <code>{plan.key}</code>
                </p>
                <p className="muted">
                  Enabled: {String(plan.enabled)} · Published:{" "}
                  {String(plan.published)} · Self-service:{" "}
                  {String(plan.selfServiceEligible)}
                </p>
                <p className="muted">Quota: {plan.requestQuota}</p>
                <p className="muted">
                  Catalogue entries: {plan.catalogueEntryIds.length}
                </p>

                <ActionForm
                  action={setPlanEnabledAction}
                  submitLabel={plan.enabled ? "Disable" : "Enable"}
                >
                  <input type="hidden" name="id" value={plan.id} />
                  <input
                    type="hidden"
                    name="enabled"
                    value={plan.enabled ? "false" : "true"}
                  />
                </ActionForm>

                <ActionForm
                  action={setPlanPublishedAction}
                  submitLabel={plan.published ? "Unpublish" : "Publish"}
                >
                  <input type="hidden" name="id" value={plan.id} />
                  <input
                    type="hidden"
                    name="published"
                    value={plan.published ? "false" : "true"}
                  />
                </ActionForm>

                <ActionForm
                  action={attachCatalogueEntryAction}
                  submitLabel="Attach entry"
                  className="admin-form"
                >
                  <input type="hidden" name="planId" value={plan.id} />
                  <input
                    type="text"
                    name="catalogueEntryId"
                    required
                    placeholder="catalogue entry id (uuid)"
                    aria-label="Catalogue entry id to attach"
                  />
                </ActionForm>

                <ActionForm
                  action={detachCatalogueEntryAction}
                  submitLabel="Detach entry"
                  className="admin-form"
                >
                  <input type="hidden" name="planId" value={plan.id} />
                  <input
                    type="text"
                    name="catalogueEntryId"
                    required
                    placeholder="catalogue entry id (uuid)"
                    aria-label="Catalogue entry id to detach"
                  />
                </ActionForm>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
