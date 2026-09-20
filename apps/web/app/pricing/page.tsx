import type { Metadata } from "next";
import Link from "next/link";
export const metadata: Metadata = { title: "Pricing" };
export default function Pricing() {
  return (
    <main id="main">
      <section className="page-hero">
        <p className="eyebrow">Plans</p>
        <h1>Simple, self-service access</h1>
        <p className="lede">
          Version 1 has no payment provider. Plans are defined by an
          administrator and claimed at no cost; each carries a request quota and
          grants specific catalogue entries. Your available plans and their
          limits appear in your account.
        </p>
        <div className="actions">
          <Link className="button" href="/account">
            View and claim plans
          </Link>
          <Link className="button secondary" href="/documentation">
            Read the documentation
          </Link>
        </div>
      </section>
      <section className="plans" aria-label="How plans work">
        <article className="card">
          <h2>How access works</h2>
          <ul>
            <li>An administrator publishes catalogue entries and plans.</li>
            <li>You claim a self-service plan from your account.</li>
            <li>Each plan grants a request quota over its catalogue entries.</li>
          </ul>
        </article>
        <article className="card">
          <h2>Governed API</h2>
          <ul>
            <li>Mint a personal access token to call the OpenAI-compatible API.</li>
            <li>
              Requests are authorized, metered against your quota, and audited.
            </li>
            <li>Upstream credentials and routing never reach your client.</li>
          </ul>
        </article>
      </section>
    </main>
  );
}
