import type { Metadata } from "next";
import type { AuditLogEntryView, UsageSummaryView } from "@sculpin/domain";
import { ensureAdminPage } from "../admin-gate";
import { getUsageSummary, listRecentAuditEvents } from "../../lib/audit";

export const metadata: Metadata = { title: "Admin · Audit" };

// Audit/usage data is per-request and re-derived from the DB; never cached.
export const dynamic = "force-dynamic";

/**
 * §11 minimum admin operational view. READ-ONLY: it renders the recent audit
 * log (§10 append-only `audit_events`) and an aggregate usage summary (S13
 * `usage_events`). No mutation and no audit event is written for this read. The
 * data layer already excludes every secret (token/PAT/digest/upstream url/
 * upstream key/upstream agent id); this page never reintroduces them — it only
 * renders the SAFE fields returned by the repositories.
 */

/** Compact, single-line rendering of a SAFE §10 summary object. */
function renderSummary(summary: unknown): string {
  if (summary === null || summary === undefined) return "—";
  // Objects/arrays render as compact JSON; primitives render via JSON.stringify
  // too (it yields a clean string/number/boolean literal without invoking a
  // default object stringification).
  return JSON.stringify(summary);
}

/** The actor label: a human email, else the system actor, else "—". */
function actorLabel(event: AuditLogEntryView): string {
  if (event.actorEmail) return event.actorEmail;
  if (event.systemActor) return `system:${event.systemActor}`;
  return "—";
}

function orgLabel(event: AuditLogEntryView): string {
  if (event.organizationSlug) return event.organizationSlug;
  if (event.organizationId) return event.organizationId;
  return "— (platform)";
}

export default async function AdminAudit() {
  // SERVER gate: a non-admin (or signed-out) caller gets a 404, never this page.
  await ensureAdminPage();
  const [events, usage]: [readonly AuditLogEntryView[], UsageSummaryView] =
    await Promise.all([listRecentAuditEvents(), getUsageSummary()]);

  return (
    <main id="main">
      <section className="page-hero">
        <p className="eyebrow">Administration</p>
        <h1>Audit &amp; usage</h1>
        <p className="lede">
          Review recent control-plane audit events and aggregate usage. This is
          a read-only view derived from canonical data; nothing here is
          fabricated and reading it records no audit event.
        </p>
      </section>

      <section aria-labelledby="usage-heading">
        <div className="section-heading">
          <h2 id="usage-heading">Usage summary</h2>
        </div>
        <p className="muted">
          Totals across all recorded per-request usage events.
        </p>
        <dl className="admin-form stacked">
          <div>
            <dt>Total requests</dt>
            <dd>{usage.totalRequestCount}</dd>
          </div>
          <div>
            <dt>Total quota cost</dt>
            <dd>{usage.totalQuotaCost}</dd>
          </div>
        </dl>
        {usage.topOrganizations.length === 0 ? (
          <p className="muted">No usage events recorded yet.</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Organization</th>
                <th scope="col">Requests</th>
                <th scope="col">Quota cost</th>
              </tr>
            </thead>
            <tbody>
              {usage.topOrganizations.map((org) => (
                <tr key={org.organizationId}>
                  <td>
                    <code>{org.organizationSlug ?? org.organizationId}</code>
                  </td>
                  <td>{org.requestCount}</td>
                  <td>{org.totalQuotaCost}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="audit-heading">
        <div className="section-heading">
          <h2 id="audit-heading">Recent audit events</h2>
        </div>
        {events.length === 0 ? (
          <p className="muted">No audit events recorded yet.</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Occurred at</th>
                <th scope="col">Action</th>
                <th scope="col">Target</th>
                <th scope="col">Actor</th>
                <th scope="col">Organization</th>
                <th scope="col">Details</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id}>
                  <td>
                    <time dateTime={event.occurredAt}>{event.occurredAt}</time>
                  </td>
                  <td>{event.action}</td>
                  <td>
                    {event.targetType} <code>{event.targetId}</code>
                  </td>
                  <td>{actorLabel(event)}</td>
                  <td>{orgLabel(event)}</td>
                  <td>
                    <code>{renderSummary(event.afterSummary)}</code>
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
