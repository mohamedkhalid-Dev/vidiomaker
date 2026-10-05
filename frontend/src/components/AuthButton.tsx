"use client";

import { useCallback, useEffect, useState } from "react";
import { isSupabaseConfigured, supabase } from "../lib/supabase";
import { createSupabaseBrowserClient } from "../lib/supabaseBrowser";

/**
 * Supabase Auth UI — magic link / email OTP sign-in.
 *
 * - Sign-in via `signInWithOtp` with `emailRedirectTo` → /auth/callback
 *   (exchanges the PKCE code for a cookie session, see app/auth/callback).
 * - Shows the signed-in user email, or "Anonymous" when logged out / unconfigured.
 * - Fully optional: when Supabase env is missing it renders a disabled
 *   "Anonymous" badge and never touches the network.
 */
export default function AuthButton(): React.ReactElement {
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageKind, setMessageKind] = useState<"ok" | "error" | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!isSupabaseConfigured()) return;
    let cancelled = false;
    supabase.auth
      .getUser()
      .then(({ data }) => {
        if (!cancelled) setUserEmail(data.user?.email ?? null);
      })
      .catch(() => {
        if (!cancelled) setUserEmail(null);
      });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setUserEmail(session?.user?.email ?? null);
    });
    return () => {
      cancelled = true;
      listener.subscription.unsubscribe();
    };
  }, []);

  const handleSignIn = useCallback(async () => {
    const clean = email.trim();
    if (clean.length === 0 || !clean.includes("@")) {
      setMessage("Enter a valid email to receive a sign-in link.");
      setMessageKind("error");
      return;
    }
    if (!isSupabaseConfigured()) {
      setMessage("Auth is not configured (missing Supabase env). Continuing as Anonymous.");
      setMessageKind("error");
      return;
    }
    setBusy(true);
    setMessage(null);
    setMessageKind(null);
    try {
      const client = createSupabaseBrowserClient();
      const { error } = await client.auth.signInWithOtp({
        email: clean,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback`,
        },
      });
      if (error) throw error;
      setMessage("Check your inbox for the sign-in link.");
      setMessageKind("ok");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Sign-in failed. Please retry.");
      setMessageKind("error");
    } finally {
      setBusy(false);
    }
  }, [email]);

  const handleSignOut = useCallback(async () => {
    if (!isSupabaseConfigured()) {
      setUserEmail(null);
      setOpen(false);
      return;
    }
    setBusy(true);
    try {
      const client = createSupabaseBrowserClient();
      await client.auth.signOut();
      setUserEmail(null);
      setOpen(false);
      setMessage(null);
      setMessageKind(null);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Sign-out failed. Please retry.");
      setMessageKind("error");
    } finally {
      setBusy(false);
    }
  }, []);

  if (!open) {
    return (
      <span className="auth-wrap">
        <span
          aria-live="polite"
          className="auth-badge"
          title={userEmail ? `Signed in as ${userEmail}` : "Browsing anonymously (Supabase Auth optional)"}
        >
          {userEmail ?? "Anonymous"}
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
          <span aria-live="polite" className="auth-badge">
            {userEmail}
          </span>
          <button
            type="button"
            onClick={() => void handleSignOut()}
            disabled={busy}
            className="auth-btn"
          >
            {busy ? "…" : "Sign out"}
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
            id="vm-auth-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
            className="auth-input"
          />
          <button
            type="submit"
            disabled={busy}
            aria-busy={busy}
            className="auth-btn"
          >
            {busy ? "Sending…" : "Send link"}
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
      {message ? (
        <span
          role="status"
          className={messageKind === "error" ? "auth-msg auth-msg-error" : messageKind === "ok" ? "auth-msg auth-msg-ok" : "auth-msg"}
        >
          {message}
        </span>
      ) : null}
    </span>
  );
}
