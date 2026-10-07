"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { isSupabaseConfigured } from "@/lib/supabase";
import { validateAuthEmail } from "@/lib/useAuth";
import { toFriendlyPasswordAuthError } from "@/lib/authErrors";
import { createSupabaseBrowserClient } from "@/lib/supabaseBrowser";

const RESEND_COOLDOWN_SECONDS = 120;
const COOLDOWN_KEY = "vm-reset-cooldown-until";

function getPersistedCooldown(): number {
  try {
    const stored = Number(localStorage.getItem(COOLDOWN_KEY) ?? 0);
    if (Number.isFinite(stored)) return Math.max(0, Math.ceil((stored - Date.now()) / 1000));
  } catch {
    // storage unavailable
  }
  return 0;
}

// Client form rendered by the server page in ./page.tsx (metadata owner).
// Sends a reset email whose link lands on /auth/callback?next=/update-password
// (code exchange → session cookie → redirect), reusing the existing callback.
export default function ForgotPasswordForm(): React.ReactElement {
  const [email, setEmail] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    setCooldown(getPersistedCooldown());
    const t = setInterval(() => {
      try {
        const stored = Number(localStorage.getItem(COOLDOWN_KEY) ?? 0);
        setCooldown(
          Number.isFinite(stored) ? Math.max(0, Math.ceil((stored - Date.now()) / 1000)) : 0,
        );
      } catch {
        setCooldown(0);
      }
    }, 500);
    return () => clearInterval(t);
  }, []);

  const configured = isSupabaseConfigured();
  const coolingDown = cooldown > 0;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (loading || coolingDown) return; // prevent double-submit / resend spam
    const emailError = validateAuthEmail(email);
    if (emailError) {
      setFieldError(emailError);
      setFormError(null);
      setNotice(null);
      return;
    }
    setFieldError(null);
    setFormError(null);
    setNotice(null);
    setLoading(true);
    try {
      const client = createSupabaseBrowserClient();
      const { error } = await client.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: `${window.location.origin}/auth/callback?next=/update-password`,
      });
      if (error) throw error;
      try {
        localStorage.setItem(COOLDOWN_KEY, String(Date.now() + RESEND_COOLDOWN_SECONDS * 1000));
      } catch {
        // ignore
      }
      setCooldown(RESEND_COOLDOWN_SECONDS);
      setNotice("Check your inbox (and spam) for the password-reset link.");
    } catch (err) {
      const message = toFriendlyPasswordAuthError(err);
      // Supabase throttled the send — still cool down to stop instant retries.
      if (message.startsWith("Email limit reached")) {
        try {
          localStorage.setItem(COOLDOWN_KEY, String(Date.now() + RESEND_COOLDOWN_SECONDS * 1000));
        } catch {
          // ignore
        }
        setCooldown(RESEND_COOLDOWN_SECONDS);
      }
      setFormError(message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card">
      {!configured ? (
        <p role="note" className="error-box" style={{ marginTop: 0 }}>
          Auth not configured on this site (missing Supabase settings). The form is disabled.
        </p>
      ) : null}
      <form
        onSubmit={(e) => void handleSubmit(e)}
        aria-busy={loading}
        style={{ display: "grid", gap: "0.75rem" }}
      >
        <fieldset
          disabled={loading || !configured}
          style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: "0.75rem" }}
        >
          <div style={{ display: "grid", gap: "0.25rem" }}>
            <label htmlFor="forgot-email" className="auth-label">
              Email
            </label>
            <input
              id="forgot-email"
              type="email"
              autoComplete="email"
              required
              maxLength={254}
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                if (fieldError && validateAuthEmail(e.target.value) === null) setFieldError(null);
              }}
              placeholder="you@example.com"
              className="auth-input"
              style={{ width: "100%" }}
            />
          </div>
          <button type="submit" disabled={loading || !configured || coolingDown} aria-busy={loading}>
            {loading ? "Sending…" : coolingDown ? `Resend in ${cooldown}s` : "Send reset link"}
          </button>
        </fieldset>
      </form>
      {fieldError ? (
        <p role="alert" className="auth-msg auth-msg-error">
          {fieldError}
        </p>
      ) : null}
      {formError ? (
        <p role="alert" className="error-box">
          {formError}
        </p>
      ) : null}
      {notice ? (
        <p role="status" aria-live="polite" className="auth-msg auth-msg-ok">
          {notice}
        </p>
      ) : null}
      <p className="auth-msg" style={{ marginTop: "0.75rem" }}>
        Remembered it? <Link href="/login">Back to log in</Link>
      </p>
    </div>
  );
}
