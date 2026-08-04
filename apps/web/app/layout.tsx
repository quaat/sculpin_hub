import type { Metadata } from "next";
import Link from "next/link";
import "./styles.css";
export const metadata: Metadata = {
  title: {
    default: "Sculpin Knowledge Hub",
    template: "%s | Sculpin Knowledge Hub",
  },
  description: "Managed access to Sculpin products and agents.",
};
const links = [
  ["Products", "/products"],
  ["Agents", "/products#agents"],
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
          <nav aria-label="Primary navigation">
            {links.map(([label, href]) => (
              <Link key={label} href={href}>
                {label}
              </Link>
            ))}
          </nav>
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
            {links.map(([label, href]) => (
              <Link key={label} href={href}>
                {label}
              </Link>
            ))}
          </nav>
          <small>Foundation preview — services are not yet enabled.</small>
        </footer>
      </body>
    </html>
  );
}
