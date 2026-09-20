import type { Metadata } from "next";
import { listCatalogueForAdmin } from "../../lib/catalogue";
import { ensureAdminPage } from "../admin-gate";
import { ActionForm } from "../action-form";
import {
  publishCatalogueAction,
  unpublishCatalogueAction,
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
          Publish or unpublish catalogue entries. Only published entries appear
          in the public model list and resolve for API callers.
        </p>
      </section>
      <section aria-label="Catalogue entries">
        {entries.length === 0 ? (
          <p className="muted">No catalogue entries yet.</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Alias</th>
                <th scope="col">Display name</th>
                <th scope="col">Upstream agent id</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td>
                    <code>{entry.publicAlias}</code>
                  </td>
                  <td>{entry.displayName}</td>
                  {/* Admin-only surface: upstreamAgentId may appear here. */}
                  <td>
                    <code>{entry.upstreamAgentId}</code>
                  </td>
                  <td>{entry.status}</td>
                  <td>
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
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
