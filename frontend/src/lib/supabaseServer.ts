import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Server-side Supabase client (Route Handlers / Server Components).
 * Reads/writes auth cookies so middleware + /auth/callback stay in sync.
 */
export async function createSupabaseServerClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
  if (url.trim().length === 0 || anonKey.trim().length === 0) {
    throw new Error("Supabase is not configured (missing NEXT_PUBLIC_SUPABASE_URL / ANON_KEY).");
  }
  const cookieStore = await cookies();
  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options?: CookieOptions }[]) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch {
          // Called from a Server Component where cookies are read-only.
          // Middleware refreshes the session instead, so this is safe to ignore.
        }
      },
    },
  });
}
