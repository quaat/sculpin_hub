import type { Metadata } from "next";
import { listCatalogueForAdmin } from "../../lib/catalogue";
import { ensureAdminPage } from "../admin-gate";
import { ActionForm } from "../action-form";
import {
  publishCatalogueAction,
  unpublishCatalogueAction,
  updateCatalogueMetadataAction,
} from "../actions";

export const metadata: Metadata = { title: "Admin · Catalogue" };
export const dynamic = "force-dynamic";

export default async function AdminCatalogue() {
  await ensureAdminPage();
  const entries = await listCatalogueForAdmin();
  return (
    <main id="main">
      <section className="page-hero">
        <p className="eyebrow">Administration</p>
        <h1>Catalogue</h1>
        <p className="lede">
          Publish or unpublish catalogue entries and edit their display metadata.
          Only published entries appear in the public model list and resolve for
          API callers. The public alias and upstream agent mapping are fixed at
          creation and cannot be changed here.
        </p>
      </section>
      <section aria-label="Catalogue entries">
        {entries.length === 0 ? (
          <p className="muted">No catalogue entries yet.</p>
        ) : (
          <div className="cards">
            {entries.map((entry) => (
              <article className="card" key={entry.id}>
                <span className="tag">{entry.status}</span>
                <h3>{entry.displayName}</h3>
                <p className="muted">
                  Alias: <code>{entry.publicAlias}</code>
                </p>
                {/* Admin-only surface: upstreamAgentId may appear here. */}
                <p className="muted">
                  Upstream agent id: <code>{entry.upstreamAgentId}</code>
                </p>
                <p className="muted">
                  Description: {entry.description ?? "none"}
                </p>
                <p className="muted">
                  Access instructions:{" "}
                  {entry.accessInstructions ? "set" : "none"}
                </p>

                {entry.status === "published" ? (
                  <ActionForm
                    action={unpublishCatalogueAction}
                    submitLabel="Unpublish"
                    pendingLabel="Unpublishing…"
                  >
                    <input type="hidden" name="id" value={entry.id} />
                  </ActionForm>
                ) : (
                  <ActionForm
                    action={publishCatalogueAction}
                    submitLabel="Publish"
                    pendingLabel="Publishing…"
                  >
                    <input type="hidden" name="id" value={entry.id} />
                  </ActionForm>
                )}

                <details className="admin-edit">
                  <summary>Edit metadata</summary>
                  <ActionForm
                    action={updateCatalogueMetadataAction}
                    submitLabel="Save changes"
                    pendingLabel="Saving…"
                    className="admin-form stacked"
                  >
                    <input type="hidden" name="id" value={entry.id} />
                    <label>
                      Display name
                      <input
                        type="text"
                        name="displayName"
                        required
                        maxLength={120}
                        defaultValue={entry.displayName}
                      />
                    </label>
                    <label>
                      Description (optional)
                      <input
                        type="text"
                        name="description"
                        maxLength={2048}
                        defaultValue={entry.description ?? ""}
                      />
                    </label>
                    <label>
                      Access instructions (optional)
                      <textarea
                        name="accessInstructions"
                        rows={4}
                        maxLength={4096}
                        defaultValue={entry.accessInstructions ?? ""}
                        placeholder="How to use this offering. Shown to entitled users on the Connect page."
                      />
                    </label>
                  </ActionForm>
                </details>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
