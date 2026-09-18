"use client";

import { useState } from "react";
import { signIn, signOut } from "../lib/auth-client";

/**
 * Minimal sign-in / sign-out affordance (M2 identity slice).
 *
 * The buttons only INITIATE the OAuth redirect or clear the server session;
 * they carry no secrets and no session state. `callbackURL`/`errorCallbackURL`
 * are pinned to same-origin `/dashboard`, never a client/env-selected target.
 */
type Provider = "google" | "github";

export function SignInControls() {
  const [pending, setPending] = useState<Provider | null>(null);
  async function start(provider: Provider) {
    setPending(provider);
    try {
      await signIn.social({
        provider,
        callbackURL: "/dashboard",
        errorCallbackURL: "/dashboard",
      });
    } finally {
      setPending(null);
    }
  }
  return (
    <div className="auth-controls">
      <button
        type="button"
        className="button"
        disabled={pending !== null}
        onClick={() => void start("google")}
      >
        {pending === "google" ? "Redirecting…" : "Sign in with Google"}
      </button>
      <button
        type="button"
        className="button"
        disabled={pending !== null}
        onClick={() => void start("github")}
      >
        {pending === "github" ? "Redirecting…" : "Sign in with GitHub"}
      </button>
    </div>
  );
}

export function SignOutControl() {
  const [pending, setPending] = useState(false);
  async function stop() {
    setPending(true);
    try {
      await signOut();
      window.location.assign("/dashboard");
    } finally {
      setPending(false);
    }
  }
  return (
    <button
      type="button"
      className="button small"
      disabled={pending}
      onClick={() => void stop()}
    >
      {pending ? "Signing out…" : "Sign out"}
    </button>
  );
}
