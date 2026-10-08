"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import SocialLoginButton from "@/components/SocialLoginButton";
import { isSupabaseConfigured } from "@/lib/supabase";
import { validateAuthEmail } from "@/lib/useAuth";
import { safeNextPath, toFriendlyPasswordAuthError } from "@/lib/authErrors";
import { createSupabaseBrowserClient } from "@/lib/supabaseBrowser";

// Client form rendered by the server page in ./page.tsx (which owns the
// metadata export — client components cannot export metadata).
export default function LoginForm({ next }: { next?: string }): React.ReactElement {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const configured = isSupabaseConfigured();
  const destination = safeNextPath(next);
  const signupHref =
    destination === "/" ? "/signup" : `/signup?next=${encodeURIComponent(destination)}`;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (loading) return; // prevent double-submit
    const emailError = validateAuthEmail(email);
    if (emailError) {
      setFieldError(emailError);
      setFormError(null);
      return;
    }
    if (password.length === 0) {
      setFieldError("Enter your password.");
      setFormError(null);
      return;
    }
    setFieldError(null);
    setFormError(null);
    setLoading(true);
    try {
      const client = createSupabaseBrowserClient();
      const { error } = await client.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (error) throw error;
      // Session cookie is set by the browser client; refresh re-renders
      // server components (incl. header) with the new session.
      router.push(destination);
      router.refresh();
    } catch (err) {
      setFormError(toFriendlyPasswordAuthError(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card">
      {/* 1. Social login is the primary entry — always on top. */}
      <SocialLoginButton next={next} label="Continue with Google" />
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="or continue with email"
        style={{ display: "flex", alignItems: "center", gap: "0.75rem", margin: "0.75rem 0" }}
      >
        <span aria-hidden="true" style={{ flex: "1 1 auto", borderTop: "1px solid currentColor", opacity: 0.25 }} />
        <span className="auth-msg" style={{ margin: 0 }}>
          or continue with email
        </span>
        <span aria-hidden="true" style={{ flex: "1 1 auto", borderTop: "1px solid currentColor", opacity: 0.25 }} />
      </div>
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
            <label htmlFor="login-email" className="auth-label">
              Email address
            </label>
            <input
              id="login-email"
              name="email"
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
          <div style={{ display: "grid", gap: "0.25rem" }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "0.5rem" }}>
              <label htmlFor="login-password" className="auth-label">
                Password
              </label>
              <Link href="/forgot-password" className="auth-msg" style={{ fontSize: "0.875rem" }}>
                Forgot password?
              </Link>
            </div>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <input
                id="login-password"
                name="password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Your password"
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
          <button type="submit" disabled={loading || !configured} aria-busy={loading}>
            {loading ? "Logging in…" : "Log in"}
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
      <p className="auth-msg" style={{ marginTop: "0.75rem", textAlign: "center" }}>
        New to Vidiomaker? <Link href={signupHref}>Create an account</Link>
      </p>
      <p className="auth-msg" style={{ marginTop: "0.25rem", textAlign: "center" }}>
        Trouble logging in? <Link href="/forgot-password">Reset your password</Link>
      </p>
    </div>
  );
}
