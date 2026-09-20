import Link from "next/link";
import { benefits, previews } from "./content";
export default function HomePage() {
  return (
    <main id="main">
      <section className="hero">
        <p className="eyebrow">Managed AI access, built for confidence</p>
        <h1>One secure hub for Sculpin products and agents</h1>
        <p className="lede">
          Discover products, choose a clear plan, and—once enabled—use governed
          API access without exposing upstream credentials.
        </p>
        <div className="actions">
          <Link className="button" href="/products">
            Explore previews
          </Link>
          <Link className="button secondary" href="/documentation">
            Read the foundation notes
          </Link>
        </div>
        <p className="notice">
          Google and GitHub authentication, self-service plans, API tokens, and
          governed Sculpin routing are live. Visit your account to claim a plan
          and mint a token.
        </p>
      </section>
      <section aria-labelledby="preview-heading">
        <div className="section-heading">
          <p className="eyebrow">Catalog direction</p>
          <h2 id="preview-heading">Products and agents, clearly presented</h2>
        </div>
        <div className="cards">
          {previews.map((item) => (
            <article className="card" key={item.name}>
              <span className="tag">{item.kind}</span>
              <h3>{item.name}</h3>
              <p>{item.text}</p>
              <span className="text-link">
                Preview details <span aria-hidden="true">→</span>
              </span>
            </article>
          ))}
        </div>
      </section>
      <section className="tint" aria-labelledby="benefit-heading">
        <div className="section-heading">
          <p className="eyebrow">A dependable foundation</p>
          <h2 id="benefit-heading">Designed for teams that value control</h2>
        </div>
        <div className="benefits">
          {benefits.map(([title, text]) => (
            <article key={title}>
              <span className="icon" aria-hidden="true">
                ✓
              </span>
              <h3>{title}</h3>
              <p>{text}</p>
            </article>
          ))}
        </div>
      </section>
      <section aria-labelledby="plans-heading">
        <div className="section-heading">
          <p className="eyebrow">Plan preview</p>
          <h2 id="plans-heading">Start simply. Scale with confidence.</h2>
          <p>
            Illustrative tiers. Your actual plans are defined by an administrator
            and claimable at no cost in v1 — they appear in your account.
          </p>
        </div>
        <div className="plans">
          <article className="card">
            <h3>Free</h3>
            <p className="price">
              £0 <small>/ month</small>
            </p>
            <p>For evaluating the managed-access experience.</p>
            <ul>
              <li>Illustrative monthly allowance</li>
              <li>Usage overview preview</li>
              <li>Community documentation</li>
            </ul>
          </article>
          <article className="card featured">
            <span className="tag">Preview</span>
            <h3>Professional</h3>
            <p className="price">No charge in v1</p>
            <p>
              For production workloads with higher, administrator-configured
              limits.
            </p>
            <ul>
              <li>Higher configurable limits</li>
              <li>Operational support options</li>
              <li>Organization-ready ownership</li>
            </ul>
          </article>
        </div>
        <div className="center">
          <Link className="button secondary" href="/pricing">
            Compare plan previews
          </Link>
        </div>
      </section>
    </main>
  );
}
