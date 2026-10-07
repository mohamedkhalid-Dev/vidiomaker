"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { isSupabaseConfigured } from "@/lib/supabase";
import {
  toFriendlyPasswordAuthError,
  validateAuthPassword,
  validatePasswordConfirm,
} from "@/lib/authErrors";
import { createSupabaseBrowserClient } from "@/lib/supabaseBrowser";

// Client form rendered by the server page in ./page.tsx (metadata owner).
// Reached via the reset-email link: /auth/callback?next=/update-password
// exchanges the code for a session cookie, so a session must exist here
// before updateUser can succeed.
export default function UpdatePasswordForm(): React.ReactElement {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [hasSession, setHasSession] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const configured = isSupabaseConfigured();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const client = createSupabaseBrowserClient();
        const { data } = await client.auth.getSession();
        if (!cancelled) setHasSession(data.session !== null);
      } catch {
        if (!cancelled) setHasSession(false);
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (loading) return; // prevent double-submit
    const passwordError = validateAuthPassword(password);
    if (passwordError) {
      setFieldError(passwordError);
      setFormError(null);
      return;
    }
    const confirmError = validatePasswordConfirm(password, confirm);
    if (confirmError) {
      setFieldError(confirmError);
      setFormError(null);
      return;
    }
    setFieldError(null);
    setFormError(null);
    setLoading(true);
    try {
      const client = createSupabaseBrowserClient();
      const { error } = await client.auth.updateUser({ password });
      if (error) throw error;
      router.push("/");
      router.refresh();
    } catch (err) {
      setFormError(toFriendlyPasswordAuthError(err));
    } finally {
      setLoading(false);
    }
  }

  if (checking) {
    return (
      <div className="card">
        <p aria-live="polite" className="auth-msg">
          Checking your reset link…
        </p>
      </div>
    );
  }

  return (
    <div className="card">
      {!configured ? (
        <p role="note" className="error-box" style={{ marginTop: 0 }}>
          Auth not configured on this site (missing Supabase settings). The form is disabled.
        </p>
      ) : null}
      {!hasSession && configured ? (
        <p role="note" className="error-box" style={{ marginTop: 0 }}>
          This reset link is invalid, expired, or was already used.{" "}
          <Link href="/forgot-password">Request a new one</Link>.
        </p>
      ) : null}
      <form
        onSubmit={(e) => void handleSubmit(e)}
        aria-busy={loading}
        style={{ display: "grid", gap: "0.75rem" }}
      >
        <fieldset
          disabled={loading || !configured || !hasSession}
          style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: "0.75rem" }}
        >
          <div style={{ display: "grid", gap: "0.25rem" }}>
            <label htmlFor="update-password" className="auth-label">
              New password (min 8 characters)
            </label>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <input
                id="update-password"
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 8 characters"
                className="auth-input"
                style={{ width: "100%", flex: "1 1 auto" }}
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-pressed={showPassword}
                aria-label={showPassword ? "Hide password" : "Show password"}
                className="auth-btn auth-btn-ghost"
              >
                {showPassword ? "Hide" : "Show"}
              </button>
            </div>
          </div>
          <div style={{ display: "grid", gap: "0.25rem" }}>
            <label htmlFor="update-confirm" className="auth-label">
              Confirm new password
            </label>
            <input
              id="update-confirm"
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Repeat your new password"
              className="auth-input"
              style={{ width: "100%" }}
            />
          </div>
          <button type="submit" disabled={loading || !configured || !hasSession} aria-busy={loading}>
            {loading ? "Saving…" : "Set new password"}
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
    </div>
  );
}
