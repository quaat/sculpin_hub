import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { listPublicModels } from "../../lib/catalogue";
import { resolvePublicHubApiUrl } from "../../lib/public-hub-url";

export const metadata: Metadata = { title: "Connect" };

// The published-alias check reads the DB on every request.
export const dynamic = "force-dynamic";

/**
 * Connect instructions for pointing a stock OpenAI client at the Hub. The route
 * `alias` is validated against the PUBLISHED catalogue (`listPublicModels`,
 * which exposes only the client-safe projection); an unpublished / unknown
 * alias 404s via `notFound()`. The page renders the PUBLIC hub api url and the
 * public alias only — never the internal Sculpin URL, the upstream credential,
 * or any internal agent id.
 */
export default async function Connect({
  params,
}: {
  readonly params: Promise<{ readonly alias: string }>;
}) {
  const { alias: rawAlias } = await params;
  const alias = decodeURIComponent(rawAlias);
  const models = await listPublicModels();
  const model = models.find((candidate) => candidate.id === alias);
  if (!model) notFound();

  const baseUrl = resolvePublicHubApiUrl();

  return (
    <main id="main">
      <section className="page-hero">
        <p className="eyebrow">Connect</p>
        <h1>Use {model.displayName}</h1>
        <p className="lede">
          Point any standard OpenAI client at the Hub. The Hub authenticates,
          authorizes, meters, and proxies accepted requests upstream — the
          upstream URL and credentials are never exposed to clients.
        </p>
      </section>
      <section className="empty" aria-labelledby="connect-settings">
        <h2 id="connect-settings">Client settings</h2>
        <dl className="connect-settings">
          <div>
            <dt>Base URL</dt>
            <dd>
              <code>{baseUrl}</code>
            </dd>
          </div>
          <div>
            <dt>Model</dt>
            <dd>
              <code>{model.id}</code>
            </dd>
          </div>
          <div>
            <dt>API key</dt>
            <dd>
              Your Personal Access Token (<code>sclp_pat_…</code>). Mint one on
              the <Link href="/account/tokens">Tokens</Link> page.
            </dd>
          </div>
        </dl>
        <p className="muted">
          Use the alias above as the OpenAI <code>model</code> id. Access is
          gated by your subscription entitlement and the token&rsquo;s scopes.
        </p>
      </section>
    </main>
  );
}
