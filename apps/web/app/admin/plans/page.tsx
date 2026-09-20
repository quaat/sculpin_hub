import type { Metadata } from "next";
import { listCatalogueForAdmin } from "../../lib/catalogue";
import { listPlansForAdmin } from "../../lib/plan-admin";
import { ensureAdminPage } from "../admin-gate";
import { ActionForm } from "../action-form";
import {
  attachCatalogueEntryAction,
  createPlanAction,
  detachCatalogueEntryAction,
  setPlanEnabledAction,
  setPlanPublishedAction,
  updatePlanAction,
} from "../actions";

export const metadata: Metadata = { title: "Admin · Plans" };
export const dynamic = "force-dynamic";

export default async function AdminPlans() {
  await ensureAdminPage();
  const [plans, catalogue] = await Promise.all([
    listPlansForAdmin(),
    listCatalogueForAdmin(),
  ]);
  // Human-readable label for a catalogue entry; the UUID stays the form VALUE.
  const entryLabel = (entry: (typeof catalogue)[number]): string =>
    `${entry.displayName} (${entry.publicAlias})`;
  const entryById = new Map(catalogue.map((entry) => [entry.id, entry]));
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
          <label className="checkbox">
            <input type="checkbox" name="adminGrantable" defaultChecked />{" "}
            Admin-grantable
          </label>
          <label className="checkbox">
            <input type="checkbox" name="oneTimePerOrganization" /> One-time per
            organization (free trials default to on)
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
                  {String(plan.selfServiceEligible)} · Admin-grantable:{" "}
                  {String(plan.adminGrantable)} · One-time:{" "}
                  {String(plan.oneTimePerOrganization)}
                </p>
                <p className="muted">
                  Quota: {plan.requestQuota}
                  {plan.durationDays !== undefined
                    ? ` · Duration: ${plan.durationDays} days`
                    : " · Duration: none"}
                </p>
                <p className="muted">
                  Attached offerings:{" "}
                  {plan.catalogueEntryIds.length === 0
                    ? "none"
                    : plan.catalogueEntryIds
                        .map((entryId) => {
                          const entry = entryById.get(entryId);
                          return entry ? entryLabel(entry) : entryId;
                        })
                        .join(", ")}
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

                <details className="admin-edit">
                  <summary>Edit plan</summary>
                  <ActionForm
                    action={updatePlanAction}
                    submitLabel="Save changes"
                    pendingLabel="Saving…"
                    className="admin-form stacked"
                  >
                    <input type="hidden" name="id" value={plan.id} />
                    <label>
                      Name
                      <input
                        type="text"
                        name="name"
                        required
                        maxLength={120}
                        defaultValue={plan.name}
                      />
                    </label>
                    <label>
                      Description (optional)
                      <input
                        type="text"
                        name="description"
                        maxLength={2048}
                        defaultValue={plan.description ?? ""}
                      />
                    </label>
                    <label>
                      Request quota
                      <input
                        type="number"
                        name="requestQuota"
                        required
                        min={0}
                        step={1}
                        defaultValue={plan.requestQuota}
                      />
                    </label>
                    <label>
                      Duration (days, optional)
                      <input
                        type="number"
                        name="durationDays"
                        min={1}
                        step={1}
                        defaultValue={plan.durationDays ?? ""}
                      />
                    </label>
                    <label className="checkbox">
                      <input
                        type="checkbox"
                        name="selfServiceEligible"
                        defaultChecked={plan.selfServiceEligible}
                      />{" "}
                      Self-service eligible
                    </label>
                    <label className="checkbox">
                      <input
                        type="checkbox"
                        name="adminGrantable"
                        defaultChecked={plan.adminGrantable}
                      />{" "}
                      Admin-grantable
                    </label>
                    <label className="checkbox">
                      <input
                        type="checkbox"
                        name="oneTimePerOrganization"
                        defaultChecked={plan.oneTimePerOrganization}
                      />{" "}
                      One-time per organization
                    </label>
                  </ActionForm>
                </details>

                <ActionForm
                  action={attachCatalogueEntryAction}
                  submitLabel="Attach offering"
                  className="admin-form"
                >
                  <input type="hidden" name="planId" value={plan.id} />
                  <label>
                    Offering to attach
                    <select
                      name="catalogueEntryId"
                      required
                      defaultValue=""
                      aria-label="Offering to attach"
                    >
                      <option value="" disabled>
                        Select an offering…
                      </option>
                      {catalogue.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entryLabel(entry)}
                        </option>
                      ))}
                    </select>
                  </label>
                </ActionForm>

                {plan.catalogueEntryIds.length > 0 ? (
                  <ActionForm
                    action={detachCatalogueEntryAction}
                    submitLabel="Detach offering"
                    className="admin-form"
                  >
                    <input type="hidden" name="planId" value={plan.id} />
                    <label>
                      Offering to detach
                      <select
                        name="catalogueEntryId"
                        required
                        defaultValue=""
                        aria-label="Offering to detach"
                      >
                        <option value="" disabled>
                          Select an attached offering…
                        </option>
                        {plan.catalogueEntryIds.map((entryId) => {
                          const entry = entryById.get(entryId);
                          return (
                            <option key={entryId} value={entryId}>
                              {entry ? entryLabel(entry) : entryId}
                            </option>
                          );
                        })}
                      </select>
                    </label>
                  </ActionForm>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
