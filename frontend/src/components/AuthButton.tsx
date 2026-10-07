"use client";

import { useEffect, useRef, useState } from "react";
import { isSupabaseConfigured } from "../lib/supabase";
import { useMagicLinkAuth, validateAuthEmail } from "../lib/useAuth";

/**
 * Supabase Auth UI — magic link / email OTP sign-in.
 *
 * - Sign-in via `signInWithOtp` with `emailRedirectTo` → /auth/callback
 *   (PKCE code exchange, see app/auth/callback). Auth state + send logic
 *   live in `lib/useAuth.ts`; this component only renders UI.
 * - Shows the signed-in email (avatar initial + address), or "Anonymous"
 *   when logged out / unconfigured.
 * - Fully optional: without Supabase env it renders a disabled
 *   "Anonymous" badge and never touches the network.
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

  const configured = isSupabaseConfigured();
  const busy = sending || signingOut;

  // Autofocus the email field whenever the panel opens.
  useEffect(() => {
    if (open && !userEmail) emailInputRef.current?.focus();
  }, [open, userEmail]);

  // Escape closes the panel (attached only while open).
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
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
    return (
      <span className="auth-wrap">
        <span
          aria-live="polite"
          className="auth-badge"
          title={
            authLoading
              ? "Checking sign-in…"
              : userEmail
                ? `Signed in as ${userEmail}`
                : "Browsing anonymously (Supabase Auth optional)"
          }
        >
          {authLoading ? "…" : (userEmail ?? "Anonymous")}
        </span>
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={userEmail ? "Manage sign-in" : "Sign in"}
          className="auth-btn"
        >
          {userEmail ? "Account" : "Sign in"}
        </button>
      </span>
    );
  }

  return (
    <span className="auth-wrap">
      {userEmail ? (
        <>
          <span aria-live="polite" className="auth-badge" title={`Signed in as ${userEmail}`}>
            <span aria-hidden="true">{avatarInitial}</span>
            <span>&nbsp;</span>
            {userEmail}
          </span>
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
            aria-label="Close account panel"
            className="auth-btn auth-btn-ghost"
          >
            Close
          </button>
        </>
      ) : (
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
            disabled={sending || cooldownSeconds > 0}
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
            aria-label="Close sign-in panel"
            className="auth-btn auth-btn-ghost"
          >
            Close
          </button>
        </form>
      )}
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
    </span>
  );
}
