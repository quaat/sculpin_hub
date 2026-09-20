import type { Metadata } from "next";
import Link from "next/link";
import { ensureAdminPage } from "./admin-gate";

export const metadata: Metadata = { title: "Admin" };

// Admin state is per-request and re-derived from the DB; never statically cached.
export const dynamic = "force-dynamic";

const sections = [
  ["Discovery", "/admin/discovery", "Discover Sculpin agents and add catalogue entries."],
  ["Catalogue", "/admin/catalogue", "Publish or unpublish model catalogue entries."],
  ["Plans", "/admin/plans", "Create plans and manage their catalogue mapping."],
  ["Subscriptions", "/admin/subscriptions", "Grant plans and change subscription status."],
  ["Audit", "/admin/audit", "Review recent control-plane audit events and usage."],
] as const;

export default async function AdminHome() {
  // SERVER gate: a non-admin (or signed-out) caller gets a 404, never this page.
  await ensureAdminPage();
  return (
    <main id="main">
      <section className="page-hero">
        <p className="eyebrow">Administration</p>
        <h1>Admin console</h1>
        <p className="lede">
          Manage the model catalogue, plans, and subscriptions. Every action is
          re-authorized server-side against your canonical admin role.
        </p>
      </section>
      <section aria-label="Admin sections">
        <div className="cards">
          {sections.map(([label, href, text]) => (
            <article className="card" key={href}>
              <h2>{label}</h2>
              <p>{text}</p>
              <Link className="text-link" href={href}>
                Open {label} <span aria-hidden="true">→</span>
              </Link>
            </article>
          ))}
        </div>
      </section>
      <section aria-labelledby="usage-audit">
        <h2 id="usage-audit">Usage &amp; audit</h2>
        <p>
          Review recent control-plane audit events and aggregate usage on the{" "}
          <Link className="text-link" href="/admin/audit">
            Audit &amp; usage
          </Link>{" "}
          view.
        </p>
      </section>
    </main>
  );
}
