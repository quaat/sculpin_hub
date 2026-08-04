import type { Metadata } from "next";
import { previews } from "../content";
export const metadata: Metadata = { title: "Products" };
export default function Products() {
  return (
    <main id="main">
      <section className="page-hero">
        <p className="eyebrow">Presentation catalog</p>
        <h1>Explore Sculpin possibilities</h1>
        <p className="lede">
          These cards demonstrate the intended catalog experience. They are not
          persisted products and cannot be subscribed to or invoked.
        </p>
      </section>
      <section id="agents" aria-label="Product and agent previews">
        <div className="cards">
          {previews.map((item) => (
            <article className="card" key={item.name}>
              <span className="tag">{item.kind}</span>
              <h2>{item.name}</h2>
              <p>{item.text}</p>
              <p className="muted">
                Availability and API compatibility are not yet certified.
              </p>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
