import type { Metadata } from "next";
import Link from "next/link";
import { PrimaryNav } from "./nav";
import "./styles.css";
export const metadata: Metadata = {
  title: {
    default: "Sculpin Knowledge Hub",
    template: "%s | Sculpin Knowledge Hub",
  },
  description: "Managed access to Sculpin products and agents.",
};

// The header/footer nav is personalized from the server session, so the shared
// layout must be rendered per-request rather than statically cached.
export const dynamic = "force-dynamic";

const footerLinks = [
  ["Products", "/products"],
  ["Pricing", "/pricing"],
  ["Documentation", "/documentation"],
] as const;
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <a className="skip" href="#main">
          Skip to content
        </a>
        <header className="site-header">
          <Link
            className="brand"
            href="/"
            aria-label="Sculpin Knowledge Hub home"
          >
            <span aria-hidden="true">S</span> Sculpin{" "}
            <strong>Knowledge Hub</strong>
          </Link>
          <PrimaryNav />
          <Link className="button small" href="/dashboard">
            Dashboard
          </Link>
        </header>
        {children}
        <footer>
          <div>
            <strong>Sculpin Knowledge Hub</strong>
            <p>Secure, managed access to Sculpin products and agents.</p>
          </div>
          <nav aria-label="Footer navigation">
            {footerLinks.map(([label, href]) => (
              <Link key={label} href={href}>
                {label}
              </Link>
            ))}
          </nav>
          <small>Secure, managed access to Sculpin products and agents.</small>
        </footer>
      </body>
    </html>
  );
}
