import type { Metadata } from "next";
import type { CatalogueDriftEntry } from "../../lib/catalogue";
import { detectCatalogueDrift } from "../../lib/catalogue";
import type { DiscoveredAgent } from "../../lib/discovery";
import { DiscoveryError, discoverSculpinAgents } from "../../lib/discovery";
import { ensureAdminPage } from "../admin-gate";
import { ActionForm } from "../action-form";
import { createFromDiscoveredAction } from "../actions";

export const metadata: Metadata = { title: "Admin · Discovery" };
export const dynamic = "force-dynamic";

/**
 * Admin discovery surface. It calls the admin-gated `discoverSculpinAgents` /
 * `detectCatalogueDrift` server-side. A `DiscoveryError` is caught and rendered
 * as a safe, secret-free notice (the internal URL / credential never appear).
 * Only STABLE (uuid-form) discovered ids are selectable when creating an entry
 * — the create action fails closed on a non-discoverable id regardless.
 */
export default async function AdminDiscovery() {
  await ensureAdminPage();

  let agents: readonly DiscoveredAgent[] = [];
  let drift: readonly CatalogueDriftEntry[] = [];
  let discoveryError: string | null = null;

  try {
    agents = await discoverSculpinAgents();
    drift = await detectCatalogueDrift();
  } catch (error) {
    if (error instanceof DiscoveryError) {
      discoveryError =
        "Discovery is unavailable right now. No upstream details are exposed.";
    } else {
      throw error;
    }
  }

  const stableAgents = agents.filter((agent) => agent.isUuid);

  return (
    <main id="main">
      <section className="page-hero">
        <p className="eyebrow">Administration</p>
        <h1>Discovery</h1>
        <p className="lede">
          Discover the current Sculpin agents and bind a public alias to a
          stable upstream agent id. Only UUID-form ids can be bound.
        </p>
      </section>

      {discoveryError ? (
        <section aria-label="Discovery status">
          <p className="form-error" role="status">
            {discoveryError}
          </p>
        </section>
      ) : (
        <>
          <section aria-labelledby="discovered-heading">
            <div className="section-heading">
              <h2 id="discovered-heading">Discovered agents</h2>
            </div>
            {agents.length === 0 ? (
              <p className="muted">No agents discovered.</p>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Id</th>
                    <th scope="col">UUID form?</th>
                    <th scope="col">Owned by</th>
                  </tr>
                </thead>
                <tbody>
                  {agents.map((agent) => (
                    <tr key={agent.id}>
                      <td>
                        <code>{agent.id}</code>
                      </td>
                      <td>{agent.isUuid ? "yes" : "no"}</td>
                      <td>{agent.ownedBy}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section aria-labelledby="create-heading">
            <div className="section-heading">
              <h2 id="create-heading">Create catalogue entry</h2>
            </div>
            {stableAgents.length === 0 ? (
              <p className="muted">
                No UUID-form agents are available to bind.
              </p>
            ) : (
              <ActionForm
                action={createFromDiscoveredAction}
                submitLabel="Create entry"
                pendingLabel="Creating…"
                className="admin-form stacked"
              >
                <label>
                  Public alias
                  <input type="text" name="publicAlias" required maxLength={64} />
                </label>
                <label>
                  Display name
                  <input type="text" name="displayName" required maxLength={120} />
                </label>
                <label>
                  Description (optional)
                  <input type="text" name="description" maxLength={2048} />
                </label>
                <label>
                  Access instructions (optional)
                  <textarea
                    name="accessInstructions"
                    rows={4}
                    maxLength={4096}
                    placeholder="How to use this offering. Shown to entitled users on the Connect page."
                  />
                </label>
                <label>
                  Upstream agent (UUID)
                  <select name="upstreamAgentId" required defaultValue="">
                    <option value="" disabled>
                      Select an agent…
                    </option>
                    {stableAgents.map((agent) => (
                      <option key={agent.agentId} value={agent.agentId}>
                        {agent.agentId}
                      </option>
                    ))}
                  </select>
                </label>
              </ActionForm>
            )}
          </section>

          <section aria-labelledby="drift-heading">
            <div className="section-heading">
              <h2 id="drift-heading">Drift report</h2>
            </div>
            {drift.length === 0 ? (
              <p className="muted">
                No drift: every stored entry maps to a discoverable stable agent.
              </p>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Alias</th>
                    <th scope="col">Upstream agent id</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {drift.map((entry) => (
                    <tr key={entry.id}>
                      <td>
                        <code>{entry.publicAlias}</code>
                      </td>
                      <td>
                        <code>{entry.upstreamAgentId}</code>
                      </td>
                      <td>{entry.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </main>
  );
}
