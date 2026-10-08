import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabaseServer";
import { safeNextPath } from "@/lib/authErrors";

/**
 * GET /auth/callback — exchanges the PKCE `code` from Supabase magic-link
 * AND OAuth (e.g. Google) for a session cookie, then redirects to safe `?next=`.
 * Only relative in-app paths are honored (open-redirect safe).
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type");
  const next = safeNextPath(url.searchParams.get("next"), "/");

  // Respect reverse proxies (Vercel / load balancers) when building the redirect origin.
  const forwardedHost = request.headers.get("x-forwarded-host");
  const origin = forwardedHost ? `https://${forwardedHost}` : url.origin;

  if (code || tokenHash) {
    try {
      const supabase = await createSupabaseServerClient();
      if (code) {
        // Covers BOTH magic-link (PKCE) and OAuth code exchange.
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        if (error) throw error;
      } else if (tokenHash && type) {
        // Backwards-compat for older magic-link / email-confirm links.
        const { error } = await supabase.auth.verifyOtp({
          token_hash: tokenHash,
          type: type as "email",
        });
        if (error) throw error;
      }
    } catch {
      return NextResponse.redirect(
        `${origin}/login?error=auth-callback-failed&next=${encodeURIComponent(next)}`,
      );
    }
  }
  return NextResponse.redirect(`${origin}${next}`);
}
