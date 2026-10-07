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
      <SocialLoginButton next={next} />
      <p className="auth-msg" style={{ textAlign: "center", margin: "0.5rem 0" }}>
        or continue with email
      </p>
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
              Email
            </label>
            <input
              id="login-email"
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
            <label htmlFor="login-password" className="auth-label">
              Password
            </label>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <input
                id="login-password"
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
      <p className="auth-msg" style={{ marginTop: "0.75rem" }}>
        New here? <Link href={signupHref}>Create an account</Link>
        {" · "}
        <Link href="/forgot-password">Forgot password?</Link>
      </p>
    </div>
  );
}
