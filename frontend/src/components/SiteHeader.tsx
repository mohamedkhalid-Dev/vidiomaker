"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMagicLinkAuth } from "../lib/useAuth";
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
 *
 * Logged out: two clear actions — "Log in" (primary, → /login) and
 * "Sign up" (secondary, → /signup). The magic-link AuthButton stays
 * as a secondary "Email link" option, not the main login.
 * Logged in: auth state hides the Log in / Sign up links; AuthButton
 * shows the email badge + Account menu with Sign out.
 */
export default function SiteHeader(): React.ReactElement {
  const pathname = usePathname();
  const { userEmail } = useMagicLinkAuth();
  const loggedOut = !userEmail;

  return (
    <header className="site-header">
      <div className="site-header-inner">
        <div className="site-header-top">
          <Link href="/" className="site-brand">
            Vidiomaker
          </Link>
          <div className="site-status">
            <KeyIndicator />
            {loggedOut ? (
              <>
                <Link
                  href="/login"
                  aria-label="Log in to your account"
                  className="site-auth-btn site-auth-btn-primary"
                >
                  Log in
                </Link>
                <Link
                  href="/signup"
                  aria-label="Create a new account"
                  className="site-auth-btn site-auth-btn-secondary"
                >
                  Sign up
                </Link>
              </>
            ) : null}
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
