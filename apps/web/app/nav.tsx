import Link from "next/link";
import { AuthzError, requireAdmin, requireUser } from "./lib/session";

/**
 * Primary nav (server component). Signed-in links (Account/Tokens) and the
 * Admin link are shown based on the SERVER-derived session/role. This is a
 * convenience only — it is NOT a security control: every account page calls
 * `requireUser` and every admin page calls the server admin gate, so a
 * hand-typed URL cannot bypass authorization. `requireUser`/`requireAdmin`
 * throw `AuthzError` when not applicable, which we swallow to hide the link.
 */
const publicLinks = [
  ["Products", "/products"],
  ["Pricing", "/pricing"],
  ["Documentation", "/documentation"],
] as const;

async function isSignedIn(): Promise<boolean> {
  try {
    await requireUser();
    return true;
  } catch (error) {
    if (error instanceof AuthzError) return false;
    throw error;
  }
}

async function isAdmin(): Promise<boolean> {
  try {
    await requireAdmin();
    return true;
  } catch (error) {
    if (error instanceof AuthzError) return false;
    throw error;
  }
}

export async function PrimaryNav() {
  const [signedIn, admin] = await Promise.all([isSignedIn(), isAdmin()]);
  return (
    <nav aria-label="Primary navigation">
      {publicLinks.map(([label, href]) => (
        <Link key={label} href={href}>
          {label}
        </Link>
      ))}
      {signedIn ? <Link href="/account">Account</Link> : null}
      {signedIn ? <Link href="/account/tokens">Tokens</Link> : null}
      {admin ? <Link href="/admin">Admin</Link> : null}
    </nav>
  );
}
