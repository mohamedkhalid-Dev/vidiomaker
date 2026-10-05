import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

export function isSupabaseConfigured(): boolean {
  return supabaseUrl.trim().length > 0 && supabaseAnonKey.trim().length > 0;
}

// Build-safe: `createClient` throws on an empty URL, which would crash
// `next build` / `next lint` on machines without env configured. Fall back
// to a clearly-marked placeholder URL — every real call site must check
// `isSupabaseConfigured()` first and show a friendly message instead.
function placeholderUrl(): string {
  return "https://supabase-not-configured.local";
}

export const supabase: SupabaseClient = isSupabaseConfigured()
  ? createClient(supabaseUrl, supabaseAnonKey)
  : createClient(placeholderUrl(), "publishable-placeholder-key");
