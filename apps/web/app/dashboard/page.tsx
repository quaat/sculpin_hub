import type { Metadata } from "next";
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
      <section className="empty" aria-labelledby="not-ready">
        <span className="empty-icon" aria-hidden="true">
          ◇
        </span>
        <h2 id="not-ready">Account features are not yet available</h2>
        <p>
          A future focused release will add subscription and usage foundations.
          No subscription, usage, or token data is currently displayed.
        </p>
      </section>
    </main>
  );
}
