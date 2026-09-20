import type { Metadata } from "next";
import Link from "next/link";
import { getSession } from "../lib/session";
import { SignInControls, SignOutControl } from "./auth-controls";

export const metadata: Metadata = { title: "Dashboard" };

// Session state is per-request; never statically cache this route.
export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const session = await getSession();

  if (!session) {
    return (
      <main id="main">
        <section className="page-hero">
          <p className="eyebrow">Identity</p>
          <h1>Sign in to Sculpin Knowledge Hub</h1>
          <p className="lede">
            Choose a provider to continue. New accounts are provisioned with a
            personal organization on first verified sign-in.
          </p>
          <SignInControls />
        </section>
      </main>
    );
  }

  return (
    <main id="main">
      <section className="page-hero">
        <p className="eyebrow">Signed in</p>
        <h1>Welcome{session.user.name ? `, ${session.user.name}` : ""}</h1>
        <p className="lede">
          You are signed in. Your session is stored server-side and can be
          revoked at any time.
        </p>
        <SignOutControl />
      </section>
      <section aria-labelledby="account-cta">
        <h2 id="account-cta">Manage your account</h2>
        <p>
          Claim a self-service plan, mint and revoke API tokens, and review your
          subscriptions and metered usage from your{" "}
          <Link className="text-link" href="/account">
            account
          </Link>
          .
        </p>
      </section>
    </main>
  );
}
