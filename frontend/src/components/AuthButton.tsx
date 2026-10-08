"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { isSupabaseConfigured } from "../lib/supabase";
import { useMagicLinkAuth, validateAuthEmail } from "../lib/useAuth";

/**
 * Header auth control. The main login path is /login and /signup
 * (Google + email/password) — linked from SiteHeader ("Log in" /
 * "Sign up") and from the dropdown panel below.
 *
 * This component is only the secondary "Email link" (magic link via
 * `signInWithOtp`) option plus, when signed in, the email badge +
 * Account menu with Sign out. Auth state + send logic live in
 * `lib/useAuth.ts`; this component only renders UI.
 */
export default function AuthButton(): React.ReactElement {
  const { userEmail, authLoading, sending, signingOut, cooldownSeconds, sendMagicLink, signOut } =
    useMagicLinkAuth();
  const [email, setEmail] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [messageKind, setMessageKind] = useState<"ok" | "error" | "info" | null>(null);
  const [open, setOpen] = useState(false);
  const emailInputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  const configured = isSupabaseConfigured();
  const busy = sending || signingOut;

  // Autofocus the email field whenever the logged-out panel opens.
  useEffect(() => {
    if (open && !userEmail) emailInputRef.current?.focus();
  }, [open, userEmail]);

  // Escape closes the panel, and outside pointer-down closes it.
  // Attached only while open.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        toggleRef.current?.focus();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (
        target &&
        panelRef.current &&
        !panelRef.current.contains(target) &&
        toggleRef.current &&
        !toggleRef.current.contains(target)
      ) {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open ]);

  const handleEmailChange = (value: string) => {
    setEmail(value);
    // Clear the inline error as soon as the value becomes valid.
    if (fieldError && validateAuthEmail(value) === null) setFieldError(null);
  };

  const handleSignIn = async () => {
    if (sending) return; // prevent double-submit
    const validationError = validateAuthEmail(email);
    if (validationError) {
      setFieldError(validationError);
      setMessage(null);
      setMessageKind(null);
      emailInputRef.current?.focus();
      return;
    }
    setFieldError(null);
    setMessage("Sending sign-in link…");
    setMessageKind("info");
    const result = await sendMagicLink(email);
    setMessage(result.message);
    setMessageKind(result.kind);
  };

  const handleSignOut = async () => {
    if (signingOut) return;
    if (!window.confirm(`Sign out${userEmail ? ` (${userEmail})` : ""}?`)) return;
    try {
      await signOut();
      setOpen(false);
      setMessage(null);
      setMessageKind(null);
      setEmail("");
      setFieldError(null);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Sign-out failed. Please retry.");
      setMessageKind("error");
    }
  };

  const avatarInitial = (userEmail ?? "?").trim().charAt(0).toUpperCase() || "?";
  const resendLabel =
    cooldownSeconds > 0 ? `Resend in ${cooldownSeconds}s` : sending ? "Sending…" : "Send link";

  if (!open) {
    // Closed: logged in → email badge + Account toggle.
    // Logged out → NO "Anonymous" pill; just the secondary "Email link"
    // toggle. The primary Log in / Sign up links live in SiteHeader.
    return (
      <span className="auth-wrap">
        {userEmail ? (
          <span aria-live="polite" className="auth-badge" title={`Signed in as ${userEmail}`}>
            <span aria-hidden="true">{avatarInitial}</span>
            <span aria-hidden="true">&nbsp;</span>
            <span className="auth-badge-email">{authLoading ? "…" : userEmail}</span>
          </span>
        ) : null}
        <button
          ref={toggleRef}
          type="button"
          onClick={() => setOpen(true)}
          aria-expanded="false"
          aria-haspopup="dialog"
          aria-label={userEmail ? `Open account menu (${userEmail})` : "More sign-in options"}
          className={userEmail ? "auth-btn" : "auth-btn auth-btn-ghost"}
        >
          {userEmail ? "Account" : "Email link"}
        </button>
      </span>
    );
  }

  // Open logged-in Account menu: email badge + Sign out.
  if (userEmail) {
    return (
      <span className="auth-wrap">
        <span aria-live="polite" className="auth-badge" title={`Signed in as ${userEmail}`}>
          <span aria-hidden="true">{avatarInitial}</span>
          <span aria-hidden="true">&nbsp;</span>
          <span className="auth-badge-email">{userEmail}</span>
        </span>
        <button
          ref={toggleRef}
          type="button"
          onClick={() => setOpen(false)}
          aria-expanded="true"
          aria-label="Close account menu"
          className="auth-btn"
        >
          Account
        </button>
        <div ref={panelRef} role="dialog" aria-label={`Account (${userEmail})`} className="auth-panel">
          <p className="auth-panel-title">Signed in</p>
          <p className="auth-panel-note">{userEmail}</p>
          <div className="auth-panel-actions">
            <button
              type="button"
              onClick={() => void handleSignOut()}
              disabled={signingOut}
              aria-busy={signingOut}
              aria-label={`Sign out (${userEmail})`}
              className="auth-btn"
            >
              {signingOut ? "Signing out…" : "Sign out"}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close account menu"
              className="auth-btn auth-btn-ghost"
            >
              Close
            </button>
          </div>
          {message ? (
            <span
              role={messageKind === "error" ? "alert" : "status"}
              aria-live="polite"
              className={
                messageKind === "error"
                  ? "auth-msg auth-msg-error"
                  : messageKind === "ok"
                    ? "auth-msg auth-msg-ok"
                    : "auth-msg"
              }
            >
              {message}
            </span>
          ) : null}
        </div>
      </span>
    );
  }

  // Open logged-out panel: main path (Log in / Sign up pages) first,
  // magic email link second.
  return (
    <span className="auth-wrap">
      <button
        ref={toggleRef}
        type="button"
        onClick={() => setOpen(false)}
        aria-expanded="true"
        aria-label="Close sign-in options"
        className="auth-btn auth-btn-ghost"
      >
        Email link
      </button>
      <div ref={panelRef} role="dialog" aria-label="Sign-in options" className="auth-panel">
        <p className="auth-panel-title">Log in or create an account</p>
        <div className="auth-panel-actions">
          <Link href="/login" aria-label="Log in with password or Google" className="auth-btn auth-btn-primary">
            Log in
          </Link>
          <Link href="/signup" aria-label="Create a new account" className="auth-btn">
            Sign up
          </Link>
        </div>
        <p className="auth-divider" aria-hidden="true">
          <span>or use an email link</span>
        </p>
        <form
          className="auth-form"
          onSubmit={(e) => {
            e.preventDefault();
            void handleSignIn();
          }}
        >
          <label htmlFor="vm-auth-email" className="auth-label">
            Email link
          </label>
          <input
            ref={emailInputRef}
            id="vm-auth-email"
            type="email"
            value={email}
            onChange={(e) => handleEmailChange(e.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
            required
            maxLength={254}
            disabled={sending}
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={fieldError ? "vm-auth-email-error" : "vm-auth-email-hint"}
            className="auth-input"
          />
          <span id="vm-auth-email-hint" hidden>
            We email you a sign-in link that expires in 1 hour.
          </span>
          <button
            type="submit"
            disabled={sending || cooldownSeconds > 0 || busy}
            aria-busy={sending}
            title={
              !configured
                ? "Sign-in is not configured on this site"
                : cooldownSeconds > 0
                  ? `Wait ${cooldownSeconds}s before resending`
                  : "Email me a sign-in link"
            }
            className="auth-btn"
          >
            {resendLabel}
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close sign-in options"
            className="auth-btn auth-btn-ghost"
          >
            Close
          </button>
        </form>
        {fieldError ? (
          <span id="vm-auth-email-error" role="alert" className="auth-msg auth-msg-error">
            {fieldError}
          </span>
        ) : null}
        {message ? (
          <span
            role={messageKind === "error" ? "alert" : "status"}
            aria-live="polite"
            className={
              messageKind === "error"
                ? "auth-msg auth-msg-error"
                : messageKind === "ok"
                  ? "auth-msg auth-msg-ok"
                  : "auth-msg"
            }
          >
            {message}
          </span>
        ) : null}
      </div>
    </span>
  );
}
