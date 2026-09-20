import Link from "next/link";
import type { PatRecord } from "@sculpin/domain";
import { MintToken } from "./mint-token";
import { RevokeToken } from "./revoke-token";

/**
 * Presentational tokens view (pure; no I/O). Lists PAT METADATA only — public
 * id, name, status, timestamps, scope count. The raw secret is never present
 * here; it is only ever shown once by {@link MintToken} at mint time. Extracted
 * so it can be unit-tested with injected props (no DB / no session).
 */
function formatDate(value?: Date): string {
  if (!value) return "—";
  return value.toISOString().slice(0, 10);
}

export function TokensView({
  tokens,
}: {
  readonly tokens: readonly PatRecord[];
}) {
  return (
    <main id="main">
      <section className="page-hero">
        <p className="eyebrow">Access tokens</p>
        <h1>Personal Access Tokens</h1>
        <p className="lede">
          Use a token as the API key with any OpenAI client. See the{" "}
          <Link href="/products">catalogue</Link> for connection details.
        </p>
      </section>

      <section aria-labelledby="mint-heading">
        <div className="section-heading">
          <h2 id="mint-heading">Mint a token</h2>
        </div>
        <MintToken />
      </section>

      <section aria-labelledby="tokens-heading">
        <div className="section-heading">
          <h2 id="tokens-heading">Your tokens</h2>
        </div>
        {tokens.length === 0 ? (
          <p className="muted">You have no tokens yet.</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Public id</th>
                <th scope="col">Name</th>
                <th scope="col">Status</th>
                <th scope="col">Created</th>
                <th scope="col">Expires</th>
                <th scope="col">Scopes</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {tokens.map((token) => (
                <tr key={token.id}>
                  <td>
                    <code>{token.publicId}</code>
                  </td>
                  <td>{token.name}</td>
                  <td>{token.status}</td>
                  <td>{formatDate(token.createdAt)}</td>
                  <td>{formatDate(token.expiresAt)}</td>
                  <td>
                    {token.scopes.length === 0
                      ? "All entitled"
                      : token.scopes.length}
                  </td>
                  <td>
                    {token.status === "active" ? (
                      <RevokeToken id={token.id} />
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
