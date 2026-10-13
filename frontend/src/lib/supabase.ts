import type { SupabaseClient } from "@supabase/supabase-js";
import { createBrowserClient } from "@supabase/ssr";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

export function isSupabaseConfigured(): boolean {
  return supabaseUrl.trim().length > 0 && supabaseAnonKey.trim().length > 0;
}

// Build-safe: creating the client must never throw during `next build`
// on machines without env configured. Fall back to a clearly-marked
// placeholder URL — every real call site must check
// `isSupabaseConfigured()` first and show a friendly message instead.
//
// Cookie storage (via @supabase/ssr, shared with middleware,
// /auth/callback, Login/Signup forms and useAuth): this is the single
// session source, so a login immediately applies to every save path
// (videos/scenes writes, uploads/, renders/). The old plain
// `createClient` singleton used isolated localStorage and stayed `anon`
// even after login — every write was RLS-rejected and silently fell
// back to in-memory blob: URLs (the "draft with no clips" symptom).
function placeholderUrl(): string {
  return "https://supabase-not-configured.local";
}

export const supabase: SupabaseClient = isSupabaseConfigured()
  ? createBrowserClient(supabaseUrl, supabaseAnonKey)
  : createBrowserClient(placeholderUrl(), "publishable-placeholder-key");
