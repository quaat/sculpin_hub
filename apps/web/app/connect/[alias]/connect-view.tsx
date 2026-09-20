import Link from "next/link";
import type { PublicModel } from "@sculpin/domain";

/**
 * Presentational Connect instructions. PURE — takes only the CLIENT-SAFE public
 * model projection (`PublicModel`, which omits the upstream agent id) and the
 * public Hub base URL. It never receives or renders the internal Sculpin URL,
 * the upstream credential, or an internal agent id. The PAT is shown only as a
 * placeholder / env reference (`$SCULPIN_HUB_PAT`), never a real token value.
 */
export function ConnectView({
  model,
  baseUrl,
}: {
  readonly model: PublicModel;
  readonly baseUrl: string;
}) {
  const curlSnippet = [
    `curl ${baseUrl}/chat/completions \\`,
    `  -H "Authorization: Bearer $SCULPIN_HUB_PAT" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{`,
    `    "model": "${model.id}",`,
    `    "messages": [{ "role": "user", "content": "Hello" }]`,
    `  }'`,
  ].join("\n");
  const pythonSnippet = [
    `from openai import OpenAI`,
    ``,
    `client = OpenAI(`,
    `    base_url="${baseUrl}",`,
    `    api_key="$SCULPIN_HUB_PAT",  # your sclp_pat_… token`,
    `)`,
    ``,
    `resp = client.chat.completions.create(`,
    `    model="${model.id}",`,
    `    messages=[{"role": "user", "content": "Hello"}],`,
    `)`,
    `print(resp.choices[0].message.content)`,
  ].join("\n");
  const nodeSnippet = [
    `import OpenAI from "openai";`,
    ``,
    `const client = new OpenAI({`,
    `  baseURL: "${baseUrl}",`,
    `  apiKey: process.env.SCULPIN_HUB_PAT, // your sclp_pat_… token`,
    `});`,
    ``,
    `const resp = await client.chat.completions.create({`,
    `  model: "${model.id}",`,
    `  messages: [{ role: "user", content: "Hello" }],`,
    `});`,
    `console.log(resp.choices[0].message.content);`,
  ].join("\n");

  return (
    <main id="main">
      <section className="page-hero">
        <p className="eyebrow">Connect</p>
        <h1>Use {model.displayName}</h1>
        <p className="lede">
          Point any standard OpenAI client at the Hub. The Hub authenticates,
          authorizes, meters, and proxies accepted requests to the model
          provider — the provider URL and credentials are never exposed to
          clients.
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
      {model.accessInstructions ? (
        <section className="empty" aria-labelledby="connect-access">
          <h2 id="connect-access">Access instructions</h2>
          <pre className="code-sample">
            <code>{model.accessInstructions}</code>
          </pre>
        </section>
      ) : null}
      <section className="empty" aria-labelledby="connect-quickstart">
        <h2 id="connect-quickstart">Quick start</h2>
        <p className="muted">
          Export your Personal Access Token first, then use any of the
          following. Replace <code>$SCULPIN_HUB_PAT</code> with the token you
          minted (it is shown only once at mint time).
        </p>

        <h3>curl</h3>
        <pre className="code-sample">
          <code>{curlSnippet}</code>
        </pre>

        <h3>OpenAI Python SDK</h3>
        <pre className="code-sample">
          <code>{pythonSnippet}</code>
        </pre>

        <h3>OpenAI Node SDK</h3>
        <pre className="code-sample">
          <code>{nodeSnippet}</code>
        </pre>

        <h3>Open WebUI</h3>
        <ol className="connect-steps">
          <li>
            Open <strong>Settings → Connections → OpenAI API</strong>.
          </li>
          <li>
            Set <strong>API Base URL</strong> to <code>{baseUrl}</code>.
          </li>
          <li>
            Set <strong>API Key</strong> to your Personal Access Token
            (<code>sclp_pat_…</code>).
          </li>
          <li>
            Save, then pick <code>{model.id}</code> from the model list to start
            chatting.
          </li>
        </ol>
      </section>
    </main>
  );
}
