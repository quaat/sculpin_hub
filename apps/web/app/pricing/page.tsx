import type { Metadata } from "next";
export const metadata: Metadata = { title: "Pricing" };
export default function Pricing() {
  return (
    <main id="main">
      <section className="page-hero">
        <p className="eyebrow">Illustrative plans</p>
        <h1>Transparent limits before you subscribe</h1>
        <p className="lede">
          The production catalog, billing provider, prices, and entitlements are
          not configured. These previews communicate the intended experience
          only.
        </p>
      </section>
      <section className="plans" aria-label="Plan previews">
        <article className="card">
          <h2>Free</h2>
          <p className="price">
            £0 <small>/ month</small>
          </p>
          <ul>
            <li>Evaluation access once enabled</li>
            <li>Published usage limits</li>
            <li>Basic documentation</li>
          </ul>
          <button disabled>Subscriptions not available</button>
        </article>
        <article className="card featured">
          <span className="tag">Preview</span>
          <h2>Professional</h2>
          <p className="price">Pricing pending</p>
          <ul>
            <li>Configurable higher allowances</li>
            <li>Rate and concurrency policies</li>
            <li>Operational support options</li>
          </ul>
          <button disabled>Checkout not configured</button>
        </article>
      </section>
    </main>
  );
}
