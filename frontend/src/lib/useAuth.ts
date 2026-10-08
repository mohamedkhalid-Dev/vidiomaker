"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isSupabaseConfigured } from "./supabase";
import { createSupabaseBrowserClient } from "./supabaseBrowser";

export const MAGIC_LINK_COOLDOWN_SECONDS = 120;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_EMAIL_LENGTH = 254;
const COOLDOWN_STORAGE_KEY = "vm-magic-link-cooldown-until";

export type AuthMessageKind = "ok" | "error" | "info";

export function validateAuthEmail(raw: string): string | null {
  const clean = raw.trim();
  if (clean.length === 0) return "Enter your email address.";
  if (clean.length > MAX_EMAIL_LENGTH || clean.includes(" ")) {
    return "That email doesn't look valid. Check for typos.";
  }
  if (!EMAIL_PATTERN.test(clean)) {
    return "Enter a valid email like you@example.com.";
  }
  return null;
}

function toFriendlyAuthError(err: unknown): string {
  const fallback = "Something went wrong. Check your connection and try again.";
  if (!(err instanceof Error)) return fallback;
  const raw = err.message.trim();
  if (raw.length === 0) return fallback;
  const lower = raw.toLowerCase();
  if (
    lower.includes("rate limit") ||
    lower.includes("too many") ||
    lower.includes("too_many") ||
    lower.includes("429") ||
    lower.includes("email rate limit") ||
    (lower.includes("after ") && lower.includes("second"))
  ) {
    return "Email limit reached (Supabase default sender allows ~30 emails/hour). Wait about an hour, then tap Resend once. If this keeps happening, the project owner needs a custom SMTP sender.";
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
    return "Sign-in isn't configured on this site (missing Supabase settings). Browsing as Anonymous.";
  }
  return raw.length > 200 ? `${raw.slice(0, 197)}…` : raw;
}

export interface UseMagicLinkAuth {
  userEmail: string | null;
  authLoading: boolean;
  sending: boolean;
  signingOut: boolean;
  cooldownSeconds: number;
  sendMagicLink: (rawEmail: string) => Promise<{ ok: boolean; message: string; kind: AuthMessageKind }>;
  signOut: () => Promise<void>;
}

/**
 * Shared magic-link auth state: session email, send with resend
 * cooldown, and sign-out. Cooldown persists in localStorage so a page
 * refresh / reopened tab can't bypass it and spam Supabase email
 * (which triggers the project-wide "email rate limit exceeded" 429).
 */
export function useMagicLinkAuth(): UseMagicLinkAuth {
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [cooldownSeconds, setCooldownSeconds] = useState(0);
  const cooldownUntilRef = useRef(0);
  const cooldownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sendingRef = useRef(false);

  const tickCooldown = useCallback(() => {
    const remaining = Math.max(0, Math.ceil((cooldownUntilRef.current - Date.now()) / 1000));
    setCooldownSeconds(remaining);
    if (remaining <= 0 && cooldownTimerRef.current) {
      clearInterval(cooldownTimerRef.current);
      cooldownTimerRef.current = null;
    }
  }, []);

  // Restore persisted cooldown (survives refresh/new tab) so users can't
  // accidentally spam resends and hit the project-wide email 429.
  useEffect(() => {
    try {
      if (typeof window === "undefined" || typeof localStorage === "undefined") return;
      const stored = Number(localStorage.getItem(COOLDOWN_STORAGE_KEY) ?? 0);
      if (Number.isFinite(stored) && stored > Date.now()) {
        cooldownUntilRef.current = stored;
        if (cooldownTimerRef.current) clearInterval(cooldownTimerRef.current);
        cooldownTimerRef.current = setInterval(tickCooldown, 500);
        tickCooldown();
      }
    } catch {
      // storage unavailable — cooldown just stays in-memory
    }
  }, [tickCooldown]);

  useEffect(() => {
    if (!isSupabaseConfigured()) {
      setAuthLoading(false);
      return;
    }
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    try {
      // Use the cookie-based browser client so state stays in sync with
      // middleware + /auth/callback (single session source).
      const client = createSupabaseBrowserClient();
      client.auth
        .getUser()
        .then(({ data }) => {
          if (!cancelled) setUserEmail(data.user?.email ?? null);
        })
        .catch(() => {
          if (!cancelled) setUserEmail(null);
        })
        .finally(() => {
          if (!cancelled) setAuthLoading(false);
        });
      const { data: listener } = client.auth.onAuthStateChange((_event, session) => {
        if (!cancelled) {
          setUserEmail(session?.user?.email ?? null);
          setAuthLoading(false);
        }
      });
      unsubscribe = () => listener.subscription.unsubscribe();
    } catch {
      if (!cancelled) {
        setUserEmail(null);
        setAuthLoading(false);
      }
    }
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  // Countdown ticker; cleared on unmount.
  useEffect(() => {
    return () => {
      if (cooldownTimerRef.current) clearInterval(cooldownTimerRef.current);
    };
  }, []);

  const startCooldown = useCallback(() => {
    cooldownUntilRef.current = Date.now() + MAGIC_LINK_COOLDOWN_SECONDS * 1000;
    try {
      if (typeof window !== "undefined" && typeof localStorage !== "undefined") {
        localStorage.setItem(COOLDOWN_STORAGE_KEY, String(cooldownUntilRef.current));
      }
    } catch {
      // ignore storage errors
    }
    setCooldownSeconds(MAGIC_LINK_COOLDOWN_SECONDS);
    if (cooldownTimerRef.current) clearInterval(cooldownTimerRef.current);
    cooldownTimerRef.current = setInterval(tickCooldown, 500);
  }, [tickCooldown]);

  const sendMagicLink = useCallback(
    async (rawEmail: string) => {
      const fieldError = validateAuthEmail(rawEmail);
      if (fieldError) return { ok: false, message: fieldError, kind: "error" as const };
      // Ref guard blocks rapid double-clicks before `sending` state re-renders.
      if (sendingRef.current || sending)
        return { ok: false, message: "Sending… please wait.", kind: "info" as const };
      const remaining = Math.max(0, Math.ceil((cooldownUntilRef.current - Date.now()) / 1000));
      if (remaining > 0) {
        return {
          ok: false,
          message: `Link already sent. You can resend in ${remaining}s.`,
          kind: "info" as const,
        };
      }
      if (!isSupabaseConfigured()) {
        return {
          ok: false,
          message:
            "Sign-in isn't configured on this site (missing Supabase settings). Browsing as Anonymous.",
          kind: "error" as const,
        };
      }
      setSending(true);
      sendingRef.current = true;
      try {
        const client = createSupabaseBrowserClient();
        const redirectOrigin =
          typeof window !== "undefined" && window.location?.origin ? window.location.origin : "";
        const { error } = await client.auth.signInWithOtp({
          email: rawEmail.trim(),
          options: { emailRedirectTo: `${redirectOrigin}/auth/callback` },
        });
        if (error) throw error;
        startCooldown();
        return {
          ok: true,
          message: "Check your inbox (and spam). The link expires in 1 hour.",
          kind: "ok" as const,
        };
      } catch (err) {
        const message = toFriendlyAuthError(err);
        // If Supabase throttled us, enforce the cooldown so the next click
        // doesn't fire another email immediately.
        if (message.startsWith("Email limit reached")) startCooldown();
        return { ok: false, message, kind: "error" as const };
      } finally {
        sendingRef.current = false;
        setSending(false);
      }
    },
    [sending, startCooldown],
  );

  const signOut = useCallback(async () => {
    if (!isSupabaseConfigured()) {
      setUserEmail(null);
      return;
    }
    setSigningOut(true);
    try {
      const client = createSupabaseBrowserClient();
      const { error } = await client.auth.signOut();
      if (error) throw error;
      setUserEmail(null);
    } finally {
      setSigningOut(false);
    }
  }, []);

  return { userEmail, authLoading, sending, signingOut, cooldownSeconds, sendMagicLink, signOut };
}
