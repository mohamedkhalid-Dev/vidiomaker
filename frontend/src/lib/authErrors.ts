// Friendly messages for Supabase email+password auth.
//
// Single mapping shared by /login, /signup, /forgot-password and
// /update-password so wording stays consistent (DRY). Matches on lowercase
// substrings because Supabase error text varies by API version.
// Email validation lives in lib/useAuth.ts (Agent 1) and is reused by the
// forms; password rules live here next to the password-error mapping.
export function toFriendlyPasswordAuthError(err: unknown): string {
  const fallback = "Something went wrong. Check your connection and try again.";
  const raw = err instanceof Error ? err.message.trim() : "";
  if (raw.length === 0) return fallback;
  const lower = raw.toLowerCase();

  if (
    lower.includes("invalid login credentials") ||
    lower.includes("invalid email or password")
  ) {
    return "Incorrect email or password. Check for typos and try again.";
  }
  if (
    lower.includes("email not confirmed") ||
    lower.includes("email not verified") ||
    lower.includes("not confirmed")
  ) {
    return "Please confirm your email first — check your inbox for the confirmation link.";
  }
  if (
    lower.includes("user already registered") ||
    lower.includes("already registered") ||
    lower.includes("already exists") ||
    lower.includes("duplicate")
  ) {
    return "An account with this email already exists. Try logging in instead.";
  }
  if (lower.includes("password") && (lower.includes("weak") || lower.includes("short") ||
      lower.includes("at least") || lower.includes("minimum") ||
      lower.includes("characters") || lower.includes("length"))) {
    return "That password is too weak — use at least 8 characters.";
  }
  if (
    lower.includes("email rate limit") ||
    lower.includes("rate limit") ||
    lower.includes("too many") ||
    lower.includes("429") ||
    (lower.includes("after ") && lower.includes("second"))
  ) {
    return "Email limit reached (Supabase default sender allows ~30 emails/hour). Wait about an hour before retrying. If this keeps happening, the project owner needs a custom SMTP sender in Supabase Dashboard → Authentication → Emails.";
  }
  if (
    lower.includes("failed to fetch") ||
    lower.includes("network") ||
    lower.includes("fetch failed") ||
    lower.includes("load failed")
  ) {
    return "Network error. Check your connection and try again.";
  }
  if (lower.includes("not configured") || lower.includes("missing")) {
    return "Auth isn't configured on this site (missing Supabase settings).";
  }
  if (lower.includes("expired") || (lower.includes("invalid") && lower.includes("token"))) {
    return "This link has expired or was already used. Request a new one below.";
  }
  if (lower.includes("same password") || lower.includes("should be different")) {
    return "Choose a new password different from your current one.";
  }
  return raw.length > 200 ? `${raw.slice(0, 197)}…` : raw;
}

export const MIN_PASSWORD_LENGTH = 8;

export function validateAuthPassword(raw: string): string | null {
  if (raw.length === 0) return "Enter your password.";
  if (raw.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  return null;
}

export function validatePasswordConfirm(password: string, confirm: string): string | null {
  if (confirm.length === 0) return "Repeat your password to confirm it.";
  if (password !== confirm) return "Passwords don't match.";
  return null;
}

// Only allow relative in-app redirects (?next=…) to avoid open redirects.
export function safeNextPath(raw: string | null | undefined, fallback = "/"): string {
  if (!raw || raw.length === 0) return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//")) return fallback;
  return raw;
}
