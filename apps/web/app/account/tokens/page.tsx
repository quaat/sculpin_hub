import type { Metadata } from "next";
import { listPersonalAccessTokens } from "../../lib/pat";
import { guard, isUnauthenticated } from "../../lib/authz-guard";
import { SignInControls } from "../../dashboard/auth-controls";
import { TokensView } from "./tokens-view";

export const metadata: Metadata = { title: "Tokens" };

// PATs are per-caller and re-read on every request; never statically cached.
export const dynamic = "force-dynamic";

export default async function TokensPage() {
  // `listPersonalAccessTokens` re-derives the caller (requireUser) and returns
  // METADATA only — never a secret or digest.
  const result = await guard(() => listPersonalAccessTokens());

  if (!result.ok) {
    return (
      <main id="main">
        <section className="page-hero">
          <p className="eyebrow">Access tokens</p>
          <h1>
            {isUnauthenticated(result.reason)
              ? "Sign in to manage tokens"
              : "Tokens unavailable"}
          </h1>
          <p className="lede">
            {isUnauthenticated(result.reason)
              ? "Choose a provider to continue."
              : "Your tokens cannot be shown right now. Please try again later."}
          </p>
          {isUnauthenticated(result.reason) ? <SignInControls /> : null}
        </section>
      </main>
    );
  }

  return <TokensView tokens={result.value} />;
}
