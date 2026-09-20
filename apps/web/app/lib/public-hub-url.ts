/**
 * Resolve the PUBLIC OpenAI-compatible base URL to show in Connect instructions.
 *
 * This is SERVER-ONLY (read in a Server Component) and returns the Hub's OWN
 * public origin + `/v1`. It is derived from `HUB_PUBLIC_URL` — the deployment
 * env var documented in `.env.example` precisely for rendering connection
 * instructions — NOT from `SCULPIN_UPSTREAM_URL` (the internal upstream, which
 * must never reach a client) and NOT from a request Host header. When the env
 * var is absent (e.g. a bare local render) a clearly-labelled placeholder is
 * returned so no internal value is ever substituted.
 */
export const HUB_API_URL_PLACEHOLDER = "https://<your-hub-host>/v1";

export function resolvePublicHubApiUrl(): string {
  const origin = process.env.HUB_PUBLIC_URL?.trim();
  if (!origin) return HUB_API_URL_PLACEHOLDER;
  return `${origin.replace(/\/+$/, "")}/v1`;
}
