import Link from "next/link";
import type { PublicModel } from "@sculpin/domain";

/**
 * Presentational catalogue list (pure; no I/O). Renders ONLY the client-safe
 * `PublicModel` projection — `id` (the public alias), `displayName`, and an
 * optional `description`. The upstream agent id is structurally absent from
 * `PublicModel`, so this component cannot leak the upstream mapping. Extracted
 * from the page so it can be unit-tested with injected props (no DB).
 */
export function ProductsView({
  models,
}: {
  readonly models: readonly PublicModel[];
}) {
  return (
    <main id="main">
      <section className="page-hero">
        <p className="eyebrow">Model catalogue</p>
        <h1>Explore Sculpin models</h1>
        <p className="lede">
          These are the published models you can call with a standard OpenAI
          client. Use a model&rsquo;s public alias as the <code>model</code> id
          and a Personal Access Token as the API key.
        </p>
      </section>
      <section id="agents" aria-label="Published models">
        {models.length === 0 ? (
          <div className="empty">
            <span className="empty-icon" aria-hidden="true">
              ◇
            </span>
            <h2>No models are published yet</h2>
            <p>
              Published models will appear here. Check back once an
              administrator has published the catalogue.
            </p>
          </div>
        ) : (
          <div className="cards">
            {models.map((model) => (
              <article className="card" key={model.id}>
                <span className="tag">Model</span>
                <h2>{model.displayName}</h2>
                <p>
                  <code>{model.id}</code>
                </p>
                {model.description ? <p>{model.description}</p> : null}
                <Link
                  className="text-link"
                  href={`/connect/${encodeURIComponent(model.id)}`}
                >
                  Connect instructions <span aria-hidden="true">→</span>
                </Link>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
