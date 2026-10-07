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
export default function SocialLoginButton({ next }: { next?: string }): React.ReactElement {
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
        className="auth-btn"
        style={{ width: "100%" }}
      >
        {loading ? "Redirecting to Google…" : "Continue with Google"}
      </button>
      {error ? (
        <p role="alert" className="auth-msg auth-msg-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
