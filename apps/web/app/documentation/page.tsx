import type { Metadata } from "next";
export const metadata: Metadata = { title: "Documentation" };
export default function Documentation() {
  return (
    <main id="main">
      <section className="page-hero">
        <p className="eyebrow">Developer documentation</p>
        <h1>Foundation documentation</h1>
        <p className="lede">
          Public API operations remain disabled until Sculpin and accounting
          contracts are certified. No endpoint currently claims OpenAI
          compatibility.
        </p>
      </section>
      <section className="empty">
        <h2>Coming in a focused release</h2>
        <p>
          Confirmed route schemas, authentication guidance, limits, streaming
          behavior, and error contracts will be published here before an API
          operation is enabled.
        </p>
      </section>
    </main>
  );
}
