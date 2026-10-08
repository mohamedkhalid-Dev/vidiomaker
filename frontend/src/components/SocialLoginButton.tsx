"use client";

import { useState } from "react";
import { isSupabaseConfigured } from "@/lib/supabase";
import { createSupabaseBrowserClient } from "@/lib/supabaseBrowser";
import { safeNextPath } from "@/lib/authErrors";

// Reusable Google social login button (DRY — shared by /login and /signup).
// Uses Supabase OAuth: redirects to Google, back to /auth/callback?next=…
// which exchanges the code for a session cookie. No emails are sent, so this
// never hits the Supabase email rate limit. Requires enabling the Google
// provider in Supabase Dashboard → Authentication → Providers.
export default function SocialLoginButton({
  next,
  label = "Continue with Google",
}: {
  next?: string;
  label?: string;
}): React.ReactElement {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const configured = isSupabaseConfigured();
  const destination = safeNextPath(next);

  async function handleGoogleLogin(): Promise<void> {
    if (loading) return;
    setError(null);
    setLoading(true);
    try {
      const client = createSupabaseBrowserClient();
      const { error: oauthError } = await client.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(destination)}`,
        },
      });
      if (oauthError) throw oauthError;
      // Redirect to Google happens automatically; loading stays true.
    } catch (err) {
      setError(err instanceof Error ? err.message : "Google sign-in failed. Try again.");
      setLoading(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: "0.5rem" }}>
      <button
        type="button"
        onClick={() => void handleGoogleLogin()}
        disabled={loading || !configured}
        aria-busy={loading}
        aria-label={label}
        title={!configured ? "Auth not configured on this site" : label}
        className="auth-btn"
        style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: "0.5rem" }}
      >
        <span aria-hidden="true" style={{ display: "inline-flex", lineHeight: 0 }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path
              d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1Z"
              fill="#4285F4"
            />
            <path
              d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z"
              fill="#34A853"
            />
            <path
              d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84Z"
              fill="#FBBC05"
            />
            <path
              d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38Z"
              fill="#EA4335"
            />
          </svg>
        </span>
        {loading ? "Redirecting to Google…" : label}
      </button>
      {error ? (
        <p role="alert" className="auth-msg auth-msg-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
