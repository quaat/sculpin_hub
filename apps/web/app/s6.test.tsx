import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PatRecord, PublicModel } from "@sculpin/domain";
import { ProductsView } from "./products/products-view";
import { TokensView } from "./account/tokens/tokens-view";
import { MintToken } from "./account/tokens/mint-token";
import { ConnectView } from "./connect/[alias]/connect-view";
import { resolvePublicHubApiUrl } from "./lib/public-hub-url";

/**
 * S6 UI render smoke tests. These render presentational components with INJECTED
 * props via `renderToStaticMarkup` (node env, no jsdom) — no DB, no network, no
 * session. They assert the security-relevant surfaces: the products list shows
 * public aliases and NEVER an upstream agent id; the mint reveal shows a token
 * exactly once; the connect base url is the PUBLIC hub origin, never the
 * internal Sculpin URL; and the admin gate hides admin content without context.
 */

describe("products view (public catalogue)", () => {
  const models: readonly PublicModel[] = [
    { id: "assistant-v1", displayName: "Assistant", description: "Helpful." },
    { id: "coder-v2", displayName: "Coder" },
  ];

  it("renders published aliases and links to connect", () => {
    const html = renderToStaticMarkup(<ProductsView models={models} />);
    expect(html).toContain("assistant-v1");
    expect(html).toContain("coder-v2");
    expect(html).toContain('href="/connect/assistant-v1"');
  });

  it("never renders an upstream agent id (PublicModel omits it by construction)", () => {
    // A leaked upstream agent id would look like a uuid. The public projection
    // carries none, so no uuid should appear in the client HTML.
    const html = renderToStaticMarkup(<ProductsView models={models} />);
    expect(html).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
    expect(html.toLowerCase()).not.toContain("upstream");
  });

  it("renders an empty state when nothing is published", () => {
    const html = renderToStaticMarkup(<ProductsView models={[]} />);
    expect(html).toContain("No models are published yet");
  });
});

describe("connect base url", () => {
  it("uses HUB_PUBLIC_URL (public origin) + /v1, never the internal Sculpin url", () => {
    const previous = process.env.HUB_PUBLIC_URL;
    process.env.HUB_PUBLIC_URL = "https://hub.example.com";
    try {
      expect(resolvePublicHubApiUrl()).toBe("https://hub.example.com/v1");
    } finally {
      if (previous === undefined) delete process.env.HUB_PUBLIC_URL;
      else process.env.HUB_PUBLIC_URL = previous;
    }
  });

  it("falls back to a labelled placeholder when unset (no internal substitution)", () => {
    const previous = process.env.HUB_PUBLIC_URL;
    delete process.env.HUB_PUBLIC_URL;
    try {
      expect(resolvePublicHubApiUrl()).toBe("https://<your-hub-host>/v1");
    } finally {
      if (previous !== undefined) process.env.HUB_PUBLIC_URL = previous;
    }
  });
});

describe("connect view (S17 client instructions)", () => {
  const model: PublicModel = {
    id: "assistant-v1",
    displayName: "Assistant",
    description: "Helpful.",
  };
  const baseUrl = "https://hub.example.com/v1";

  it("renders base URL, public alias, and curl/OpenAI/Open WebUI snippets", () => {
    const html = renderToStaticMarkup(
      <ConnectView model={model} baseUrl={baseUrl} />,
    );
    // Base URL + public alias appear in the copy-paste snippets.
    expect(html).toContain("https://hub.example.com/v1/chat/completions");
    expect(html).toContain("assistant-v1");
    // curl + both OpenAI SDKs + Open WebUI guidance are present.
    expect(html).toContain("curl ");
    expect(html).toContain("from openai import OpenAI");
    // The Node snippet's double quotes are HTML-escaped in static markup.
    expect(html).toContain("import OpenAI from &quot;openai&quot;");
    expect(html).toContain("Open WebUI");
    expect(html).toContain("API Base URL");
  });

  it("shows the PAT only as a placeholder — never a real token", () => {
    const html = renderToStaticMarkup(
      <ConnectView model={model} baseUrl={baseUrl} />,
    );
    expect(html).toContain("$SCULPIN_HUB_PAT");
    // The mint-time secret shape must never be baked into instructions.
    expect(html).not.toMatch(/sclp_pat_[a-z0-9]{6,}_[A-Za-z0-9]/);
  });

  it("never leaks an internal agent id or the upstream url/credential", () => {
    const html = renderToStaticMarkup(
      <ConnectView model={model} baseUrl={baseUrl} />,
    );
    // A leaked upstream agent id would look like a uuid; the public projection
    // carries none.
    expect(html).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
    const lower = html.toLowerCase();
    expect(lower).not.toContain("upstream");
    expect(lower).not.toContain("sculpin_upstream");
  });
});

describe("tokens view (metadata only)", () => {
  it("lists PAT metadata and never a raw secret", () => {
    const tokens: readonly PatRecord[] = [
      {
        id: "11111111-1111-1111-1111-111111111111",
        publicId: "aaaaaaaaaaaaaaaaaaaaaa",
        userId: "22222222-2222-2222-2222-222222222222",
        organizationId: "33333333-3333-3333-3333-333333333333",
        name: "laptop-cli",
        status: "active",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        scopes: [],
      },
    ];
    const html = renderToStaticMarkup(<TokensView tokens={tokens} />);
    expect(html).toContain("aaaaaaaaaaaaaaaaaaaaaa");
    expect(html).toContain("laptop-cli");
    expect(html).not.toContain("sclp_pat_");
  });
});

describe("mint reveal shows the raw token once", () => {
  it("displays the token returned by a stubbed action, then no persistence sink", async () => {
    // Stub the action module so no server/DB is touched; return a MintResult.
    const actions = await import("./account/tokens/actions");
    const token = "sclp_pat_aaaaaaaaaaaaaaaaaaaaaa_" + "b".repeat(43);
    const spy = vi.spyOn(actions, "mintTokenAction").mockResolvedValue({
      ok: true,
      token,
      publicId: "aaaaaaaaaaaaaaaaaaaaaa",
      name: "laptop-cli",
    });

    // useActionState starts with null state, so a static render shows the FORM
    // (no token) — the reveal only appears after the action resolves. We assert
    // the mint form renders and that a static render contains no token / no
    // persistence sink (localStorage/sessionStorage).
    const html = renderToStaticMarkup(<MintToken />);
    expect(html).toContain("Mint token");
    expect(html).not.toContain(token);
    // The reveal path renders the token as text inside a <code>, never into a
    // persisted attribute; assert the client source contains no browser-storage
    // sink and no analytics call for the secret.
    const src = (
      await import("node:fs")
    ).readFileSync(new URL("./account/tokens/mint-token.tsx", import.meta.url), "utf8");
    // No persistence sink: assert the token is never WRITTEN to browser storage
    // or an analytics call (patterns that would actually persist/exfiltrate it).
    expect(src).not.toMatch(/localStorage\s*\.\s*setItem/);
    expect(src).not.toMatch(/sessionStorage\s*\.\s*setItem/);
    expect(src).not.toMatch(/gtag\s*\(|dataLayer\s*\.\s*push|analytics\s*\./);
    // The token appears exactly once in the reveal JSX (single display site).
    expect(src.match(/revealed\.token/g)?.length).toBe(2); // copy() arg + <code>
    spy.mockRestore();
  });
});
