import type { Metadata } from "next";
import { listPersonalAccessTokens } from "../../lib/pat";
import {
  resolveScopableOfferings,
  resolveScopeLabels,
} from "../../lib/pat-scopes";
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

  const tokens = result.value;

  // Both reads are best-effort enrichment: the scope selector and the scope
  // labels degrade to empty (never an error page) if entitlement/catalogue
  // resolution hiccups, since the token list itself already succeeded.
  const offeringsResult = await guard(() => resolveScopableOfferings());
  const offerings = offeringsResult.ok
    ? offeringsResult.value.map((offering) => ({
        publicAlias: offering.publicAlias,
        displayName: offering.displayName,
      }))
    : [];

  const scopeIds = [...new Set(tokens.flatMap((token) => token.scopes))];
  const labelsResult = await guard(() => resolveScopeLabels(scopeIds));
  const scopeLabels = labelsResult.ok
    ? labelsResult.value
    : new Map<string, string>();

  return (
    <TokensView
      tokens={tokens}
      offerings={offerings}
      scopeLabels={scopeLabels}
    />
  );
}
