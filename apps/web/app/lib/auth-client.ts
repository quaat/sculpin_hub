"use client";

import { createAuthClient } from "better-auth/react";

/**
 * Browser-side Better Auth client (M2 identity slice).
 *
 * Same-origin: the client talks to the Next.js catch-all handler under
 * `/api/auth`, so no base URL / cross-origin target is configured here. Used
 * only to initiate the OAuth redirect (`signIn.social`) and to sign out
 * (`signOut`); all session state remains server-side (database sessions).
 */
export const authClient = createAuthClient();

export const { signIn, signOut } = authClient;
