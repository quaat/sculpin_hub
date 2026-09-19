import type { Metadata } from "next";
export const metadata: Metadata = { title: "Documentation" };
export default function Documentation() {
  return (
    <main id="main">
      <section className="page-hero">
        <p className="eyebrow">Developer documentation</p>
        <h1>Using the Hub API</h1>
        <p className="lede">
          The Hub exposes an OpenAI-compatible <code>/v1</code> surface. Point
          any standard OpenAI client at the Hub, authenticate with a Personal
          Access Token, and the Hub authenticates, authorizes, meters, and
          proxies accepted requests to Sculpin. Unknown routes are never
          forwarded.
        </p>
      </section>
      <section className="empty">
        <h2>Supported operations</h2>
        <p>
          Exactly two operations are enabled: <code>GET /v1/models</code> lists
          the public model aliases you are entitled to use, and{" "}
          <code>POST /v1/chat/completions</code> runs a chat completion (set{" "}
          <code>stream: true</code> for server-sent events). Every other{" "}
          <code>/v1/*</code> path returns a normalized error and is never
          proxied.
        </p>
      </section>
      <section className="empty">
        <h2>Authentication</h2>
        <p>
          Requests are authorized with a Personal Access Token of the form{" "}
          <code>sclp_pat_&lt;id&gt;_&lt;secret&gt;</code>, sent as{" "}
          <code>Authorization: Bearer &lt;token&gt;</code>. The raw token is
          shown once when minted and is never recoverable afterward. Your token
          identifies you to the Hub only; it is never forwarded to Sculpin, and
          the Hub&rsquo;s upstream credentials and internal URL are never
          exposed to clients.
        </p>
      </section>
      <section className="empty">
        <h2>Example: the stock OpenAI client</h2>
        <pre>
          <code>{`import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.SCULPIN_HUB_PAT, // sclp_pat_<id>_<secret>
  baseURL: "https://your-hub.example.com/v1",
});

const completion = await client.chat.completions.create({
  model: "support", // a published Hub alias, not an internal agent id
  messages: [{ role: "user", content: "Hello" }],
});
console.log(completion.choices[0]?.message.content);`}</code>
        </pre>
      </section>
      <section className="empty">
        <h2>Errors</h2>
        <p>
          Errors follow the OpenAI error shape with stable codes:{" "}
          <code>invalid_api_key</code> (401),{" "}
          <code>no_active_subscription</code> (403),{" "}
          <code>model_not_found</code> (404), <code>insufficient_quota</code>{" "}
          (429), and <code>upstream_unavailable</code> (502). Error bodies never
          contain internal details.
        </p>
      </section>
    </main>
  );
}
