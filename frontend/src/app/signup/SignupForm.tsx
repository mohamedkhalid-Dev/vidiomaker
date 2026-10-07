"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import SocialLoginButton from "@/components/SocialLoginButton";
import { isSupabaseConfigured } from "@/lib/supabase";
import { validateAuthEmail } from "@/lib/useAuth";
import {
  safeNextPath,
  toFriendlyPasswordAuthError,
  validateAuthPassword,
  validatePasswordConfirm,
} from "@/lib/authErrors";
import { createSupabaseBrowserClient } from "@/lib/supabaseBrowser";

// Client form rendered by the server page in ./page.tsx (metadata owner).
export default function SignupForm({ next }: { next?: string }): React.ReactElement {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    const read = (): number => {
      try {
        const stored = Number(localStorage.getItem("vm-signup-cooldown-until") ?? 0);
        return Number.isFinite(stored) ? Math.max(0, Math.ceil((stored - Date.now()) / 1000)) : 0;
      } catch {
        return 0;
      }
    };
    setCooldown(read());
    const t = setInterval(() => setCooldown(read()), 500);
    return () => clearInterval(t);
  }, []);

  const configured = isSupabaseConfigured();
  const destination = safeNextPath(next);
  const loginHref =
    destination === "/" ? "/login" : `/login?next=${encodeURIComponent(destination)}`;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (loading || cooldown > 0) return; // prevent double-submit / resend spam
    const emailError = validateAuthEmail(email);
    if (emailError) {
      setFieldError(emailError);
      setFormError(null);
      setNotice(null);
      return;
    }
    const passwordError = validateAuthPassword(password);
    if (passwordError) {
      setFieldError(passwordError);
      setFormError(null);
      setNotice(null);
      return;
    }
    const confirmError = validatePasswordConfirm(password, confirm);
    if (confirmError) {
      setFieldError(confirmError);
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
      const { data, error } = await client.auth.signUp({
        email: email.trim(),
        password,
        options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
      });
      if (error) throw error;
      if (data.session) {
        // Email confirmation is off — user is already signed in.
        router.push(destination);
        router.refresh();
        return;
      }
      // Email confirmation is on — no session until the inbox link is clicked.
      try {
        localStorage.setItem("vm-signup-cooldown-until", String(Date.now() + 120 * 1000));
      } catch {
        // ignore
      }
      setCooldown(120);
      setNotice(
        "Account created — check your inbox (and spam) to confirm your email, then log in.",
      );
    } catch (err) {
      const message = toFriendlyPasswordAuthError(err);
      if (message.startsWith("Email limit reached")) {
        try {
          localStorage.setItem("vm-signup-cooldown-until", String(Date.now() + 120 * 1000));
        } catch {
          // ignore
        }
        setCooldown(120);
      }
      setFormError(message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card">
      <SocialLoginButton next={next} />
      <p className="auth-msg" style={{ textAlign: "center", margin: "0.5rem 0" }}>
        or sign up with email
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
            <label htmlFor="signup-email" className="auth-label">
              Email
            </label>
            <input
              id="signup-email"
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
            <label htmlFor="signup-password" className="auth-label">
              Password (min 8 characters)
            </label>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <input
                id="signup-password"
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
            <label htmlFor="signup-confirm" className="auth-label">
              Confirm password
            </label>
            <input
              id="signup-confirm"
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Repeat your password"
              className="auth-input"
              style={{ width: "100%" }}
            />
          </div>
          <button type="submit" disabled={loading || !configured || cooldown > 0} aria-busy={loading}>
            {loading ? "Creating account…" : cooldown > 0 ? `Resend in ${cooldown}s` : "Sign up"}
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
        Already have an account? <Link href={loginHref}>Log in</Link>
      </p>
    </div>
  );
}
