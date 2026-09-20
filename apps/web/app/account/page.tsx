import type { Metadata } from "next";
import { getOrganizationEntitlement } from "../lib/entitlement";
import {
  listCallerSubscriptions,
  listSelfServicePlans,
  resolveCallerPersonalOrganizationId,
} from "../lib/subscription";
import { guard, isUnauthenticated } from "../lib/authz-guard";
import { SignInControls } from "../dashboard/auth-controls";
import { AccountView } from "./account-view";

export const metadata: Metadata = { title: "Account" };

// Account data is per-caller and re-read on every request; never statically cached.
export const dynamic = "force-dynamic";

export default async function AccountPage() {
  // The SERVER gate is authoritative: each lib call re-derives the caller from
  // the canonical `users` row. `guard` maps an AuthzError to a safe outcome.
  const result = await guard(async () => {
    const organizationId = await resolveCallerPersonalOrganizationId();
    const [{ entitlement }, subscriptions, plans] = await Promise.all([
      getOrganizationEntitlement(organizationId),
      listCallerSubscriptions(),
      listSelfServicePlans(),
    ]);
    return { entitlement, subscriptions, plans };
  });

  if (!result.ok) {
    return (
      <main id="main">
        <section className="page-hero">
          <p className="eyebrow">Account</p>
          <h1>
            {isUnauthenticated(result.reason)
              ? "Sign in to view your account"
              : "Account unavailable"}
          </h1>
          <p className="lede">
            {isUnauthenticated(result.reason)
              ? "Choose a provider to continue."
              : "Your account cannot be shown right now. Please try again later."}
          </p>
          {isUnauthenticated(result.reason) ? <SignInControls /> : null}
        </section>
      </main>
    );
  }

  return (
    <AccountView
      entitlement={result.value.entitlement}
      subscriptions={result.value.subscriptions}
      plans={result.value.plans}
    />
  );
}
