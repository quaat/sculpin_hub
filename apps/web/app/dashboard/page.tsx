import type { Metadata } from "next";
export const metadata: Metadata = { title: "Dashboard" };
export default function Dashboard() {
  return (
    <main id="main">
      <section className="page-hero">
        <p className="eyebrow">Foundation state</p>
        <h1>Your dashboard will live here</h1>
        <p className="lede">
          Authentication and subscriptions are not configured in this
          implementation slice. This page is public and does not indicate that
          you are signed in.
        </p>
      </section>
      <section className="empty" aria-labelledby="not-ready">
        <span className="empty-icon" aria-hidden="true">
          ◇
        </span>
        <h2 id="not-ready">Account features are not yet available</h2>
        <p>
          A future focused release will add secure identity and personal
          organization foundations. No account, subscription, usage, or token
          data is currently displayed.
        </p>
      </section>
    </main>
  );
}
