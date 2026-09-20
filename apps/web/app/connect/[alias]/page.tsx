import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { listPublicModels } from "../../lib/catalogue";
import { resolvePublicHubApiUrl } from "../../lib/public-hub-url";
import { ConnectView } from "./connect-view";

export const metadata: Metadata = { title: "Connect" };

// The published-alias check reads the DB on every request.
export const dynamic = "force-dynamic";

/**
 * Connect instructions for pointing a stock OpenAI client at the Hub. The route
 * `alias` is validated against the PUBLISHED catalogue (`listPublicModels`,
 * which exposes only the client-safe projection); an unpublished / unknown
 * alias 404s via `notFound()`. Data-fetching only; the client-safe rendering
 * (base URL + public alias + copy-paste client snippets, never the internal
 * Sculpin URL / credential / agent id) lives in the pure `ConnectView`.
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

  return <ConnectView model={model} baseUrl={resolvePublicHubApiUrl()} />;
}
