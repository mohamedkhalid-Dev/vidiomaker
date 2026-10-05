import { createBrowserClient } from "@supabase/ssr";

/**
 * Browser-side Supabase client (cookie-based, works with middleware +
 * /auth/callback code exchange). Use in Client Components like AuthButton.
 */
export function createSupabaseBrowserClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
  if (url.trim().length === 0 || anonKey.trim().length === 0) {
    throw new Error("Supabase is not configured (missing NEXT_PUBLIC_SUPABASE_URL / ANON_KEY).");
  }
  return createBrowserClient(url, anonKey);
}
