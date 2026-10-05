"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import AuthButton from "./AuthButton";
import KeyIndicator from "./KeyIndicator";

const NAV_LINKS = [
  { href: "/create", label: "Create" },
  { href: "/history", label: "History" },
  { href: "/settings", label: "Settings" },
] as const;

/**
 * Global site header (client island for active nav state).
 * Static — not sticky — for simplicity: no overlap, no scroll JS,
 * content is never hidden behind the header on small screens.
 */
export default function SiteHeader(): React.ReactElement {
  const pathname = usePathname();

  return (
    <header className="site-header">
      <div className="site-header-inner">
        <div className="site-header-top">
          <Link href="/" className="site-brand">
            Vidiomaker
          </Link>
          <div className="site-status">
            <KeyIndicator />
            <AuthButton />
          </div>
        </div>
        <nav aria-label="Main navigation" className="site-nav">
          {NAV_LINKS.map((link) => {
            const isActive = pathname === link.href;
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={isActive ? "page" : undefined}
                className={isActive ? "nav-link active" : "nav-link"}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
