"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { API_KEY_STORAGE_KEY } from "../lib/openrouter";
import { toUserMessage } from "../lib/errors";

/**
 * Stage 2.4 — OpenRouter API key management (Agent 1: Vercel-native, no Laravel).
 *
 * - Password-type input, Show/Hide toggle, Save / Test / Clear.
 * - Save persists to localStorage (vidiomaker.openrouter_key) only — there
 *   is no /api/settings/key route. The full key is never logged.
 * - Test POSTs same-origin (POST /api/models/test) which runs a tiny
 *   openai/gpt-4o-mini "hi" probe. The key travels in the POST body
 *   (or Authorization header for generation calls) — never in URLs.
 * - Friendly errors: 401 -> link to Settings/OpenRouter keys, 429 -> retry
 *   countdown, network failure -> Retry button.
 */

export const KEY_CHANGE_EVENT = "vidiomaker:key-change";

const THEME = {
  background: "#000",
  text: "#B8B8B8",
  muted: "#808080",
  card: "#111",
  border: "#2A2A2A",
  button: "#1A1A1A",
  heading: "#D4D4D4",
} as const;

const RETRY_AFTER_SECONDS = 30;

// All calls below use same-origin relative /api/* Route Handlers.

function maskKey(key: string): string {
  if (!key) return "(none)";
  return `****${key.slice(-4)}`;
}

function readStoredKey(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(API_KEY_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function notifyKeyChange(): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent(KEY_CHANGE_EVENT));
  } catch {
    // Non-fatal: header indicator also polls storage events.
  }
}

type StatusKind = "idle" | "saving" | "testing" | "success" | "error";

export default function SettingsApiKey(): React.ReactElement {
  const [keyInput, setKeyInput] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [hasStoredKey, setHasStoredKey] = useState(false);
  const [status, setStatus] = useState<StatusKind>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [isRateLimited, setIsRateLimited] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const countdownTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Hydrate from localStorage on mount (avoids SSR mismatch).
  useEffect(() => {
    const stored = readStoredKey();
    setKeyInput(stored);
    setHasStoredKey(stored.trim().length > 0);
  }, []);

  // 429 retry countdown.
  useEffect(() => {
    if (countdown <= 0) {
      if (countdownTimer.current) {
        clearInterval(countdownTimer.current);
        countdownTimer.current = null;
      }
      setIsRateLimited(false);
      return;
    }
    setIsRateLimited(true);
    countdownTimer.current = setInterval(() => {
      setCountdown((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => {
      if (countdownTimer.current) clearInterval(countdownTimer.current);
    };
  }, [countdown]);

  const busy = status === "saving" || status === "testing";

  async function runTest(candidate: string): Promise<void> {
    // Key in POST body only — never in URL, never logged client-side.
    const res = await fetch("/api/models/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: candidate }),
    });
    let payload: { ok?: boolean; message?: string } | null = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }
    if (!res.ok && res.status !== 200) {
      if (res.status === 401) {
        setStatus("error");
        setMessage("Invalid API key (401). Paste a fresh key and try again.");
        return;
      }
      if (res.status === 429) {
        setStatus("error");
        setMessage("OpenRouter is busy (429). Retry shortly — key is saved.");
        setCountdown(RETRY_AFTER_SECONDS);
        return;
      }
      setStatus("error");
      setMessage(
        typeof payload?.message === "string" && payload.message
          ? payload.message
          : `Key test failed (${res.status}). Please retry.`
      );
      return;
    }
    if (payload?.ok) {
      setStatus("success");
      setMessage(payload.message || "Key saved and verified — ready to generate.");
      return;
    }
    const detail = typeof payload?.message === "string" ? payload.message : "";
    if (/401/.test(detail)) {
      setStatus("error");
      setMessage(detail);
      return;
    }
    if (/429|busy|rate/i.test(detail)) {
      setStatus("error");
      setMessage(detail || "OpenRouter is busy (429). Key is saved — retry shortly.");
      setCountdown(RETRY_AFTER_SECONDS);
      return;
    }
    setStatus("error");
    setMessage(detail || "Key test failed. Please retry.");
  }

  // Agent 1 (Vercel-native, no Laravel): Save is localStorage-only. There is
  // no /api/settings/key route to sync to — the full key never leaves this
  // browser except per-request to /api/* (POST body / Bearer header, never
  // in URLs, never logged). Test verifies it via POST /api/models/test.
  // Simplified flow (2 clicks): paste → Test & Save.
  const handleTestAndSave = useCallback(async () => {
    const trimmed = keyInput.trim();
    setMessage(null);
    if (trimmed.length < 8) {
      setStatus("error");
      setMessage("Paste your key first, then press Test & Save.");
      return;
    }
    setStatus("testing");
    try {
      window.localStorage.setItem(API_KEY_STORAGE_KEY, trimmed);
    } catch {
      setStatus("error");
      setMessage("Could not save locally (storage unavailable). Key not saved.");
      return;
    }
    setHasStoredKey(true);
    notifyKeyChange();
    try {
      await runTest(trimmed);
    } catch (err) {
      setStatus("error");
      setMessage(
        toUserMessage(err, "Key saved, but the test could not reach the server. Retry.")
      );
    }
  }, [keyInput]);

  const handleClear = useCallback(() => {
    try {
      window.localStorage.removeItem(API_KEY_STORAGE_KEY);
    } catch {
      // Ignore storage errors on clear.
    }
    setKeyInput("");
    setHasStoredKey(false);
    setStatus("idle");
    setMessage("Key cleared from this browser.");
    notifyKeyChange();
  }, []);

  const showCountdown = isRateLimited && countdown > 0;
  const isError = status === "error";
  const isInvalidKey = isError && message !== null && /401|invalid/i.test(message);
  // 422 validation → highlight the key field so the user sees what to fix.
  const isValidationError =
    isError && message !== null && /422|format|at least 8/i.test(message);

  const inputStyle: React.CSSProperties = {
    width: "100%",
    minHeight: 44,
    padding: "10px 12px",
    borderRadius: 8,
    border: `1px solid ${THEME.border}`,
    background: THEME.card,
    color: THEME.text,
    fontSize: 16,
    boxSizing: "border-box",
  };

  const buttonStyle: React.CSSProperties = {
    minHeight: 44,
    minWidth: 44,
    padding: "10px 20px",
    borderRadius: 8,
    border: `1px solid ${THEME.border}`,
    background: THEME.button,
    color: THEME.heading,
    fontSize: 16,
    cursor: busy || showCountdown ? "not-allowed" : "pointer",
    opacity: busy || showCountdown ? 0.6 : 1,
  };

  return (
    <section
      aria-label="OpenRouter API key settings"
      style={{
        background: THEME.background,
        color: THEME.text,
        border: `1px solid ${THEME.border}`,
        borderRadius: 12,
        padding: 16,
        width: "100%",
        maxWidth: 720,
      }}
    >
      <h2 style={{ color: THEME.heading, margin: "0 0 8px", fontSize: 20 }}>
        OpenRouter API key{" "}
        <span
          role="status"
          aria-live="polite"
          style={{
            fontSize: 13,
            fontWeight: 400,
            border: `1px solid ${THEME.border}`,
            borderRadius: 999,
            padding: "2px 10px",
            marginLeft: 8,
            whiteSpace: "nowrap",
          }}
        >
          {hasStoredKey ? "● Saved" : "○ Not set"}
        </span>
      </h2>
      <p style={{ color: THEME.muted, margin: "0 0 16px", fontSize: 14, lineHeight: 1.5 }}>
        Paste a key from{" "}
        <a
          href="https://openrouter.ai/keys"
          target="_blank"
          rel="noreferrer"
          style={{ color: THEME.heading, textDecoration: "underline" }}
        >
          openrouter.ai/keys
        </a>{" "}
        → press Test &amp; Save. Stored only in this browser{keyInput.trim() ? ` (${maskKey(keyInput.trim())})` : ""}.
      </p>

      <label htmlFor="openrouter-key" style={{ display: "block", marginBottom: 8, fontSize: 14 }}>
        API key
      </label>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input
          id="openrouter-key"
          type={showKey ? "text" : "password"}
          value={keyInput}
          onChange={(event) => setKeyInput(event.target.value)}
          placeholder="sk-or-v1-..."
          autoComplete="off"
          spellCheck={false}
          aria-describedby="openrouter-key-help"
          aria-invalid={isValidationError || undefined}
          className={isValidationError ? "field-invalid" : undefined}
          style={{ ...inputStyle, flex: "1 1 240px" }}
        />
        <button
          type="button"
          onClick={() => setShowKey((prev) => !prev)}
          aria-label={showKey ? "Hide API key" : "Show API key"}
          aria-pressed={showKey}
          style={{ ...buttonStyle, flex: "0 0 auto" }}
        >
          {showKey ? "Hide" : "Show"}
        </button>
      </div>
      <p id="openrouter-key-help" style={{ color: THEME.muted, fontSize: 12, margin: "8px 0 0" }}>
        2 clicks: paste → Test &amp; Save.
      </p>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 16 }}>
        <button
          type="button"
          onClick={() => void handleTestAndSave()}
          disabled={busy || showCountdown}
          style={{ ...buttonStyle, fontWeight: 600 }}
        >
          {status === "testing" ? "Testing…" : showCountdown ? `Retry in ${countdown}s` : "Test & Save"}
        </button>
      </div>
      <details style={{ marginTop: 12 }}>
        <summary style={{ minHeight: 44, display: "inline-flex", alignItems: "center", cursor: "pointer", fontSize: 14 }}>
          Advanced (storage key, clear)
        </summary>
        <p style={{ color: THEME.muted, fontSize: 12, margin: "8px 0" }}>
          Saved as {API_KEY_STORAGE_KEY} in this browser only. Sent per request via POST body / Authorization header — never in URLs.
        </p>
        <button type="button" onClick={handleClear} disabled={busy} style={buttonStyle}>
          Clear key
        </button>
      </details>

      {showCountdown ? (
        <p role="status" style={{ color: THEME.muted, fontSize: 14, margin: "12px 0 0" }}>
          OpenRouter is busy (429). You can retry in {countdown}s — no need to re-paste your key.
        </p>
      ) : null}

      {message ? (
        <div
          role={isError ? "alert" : "status"}
          style={{
            marginTop: 12,
            border: `1px solid ${THEME.border}`,
            borderRadius: 8,
            background: THEME.card,
            padding: "12px 16px",
            fontSize: 14,
            lineHeight: 1.5,
          }}
        >
          <p style={{ margin: 0 }}>{message}</p>
          {isInvalidKey ? (
            <p style={{ margin: "8px 0 0" }}>
              You are already in Settings — paste a fresh key above, or create
              a new one at{" "}
              <a
                href="https://openrouter.ai/keys"
                target="_blank"
                rel="noreferrer"
                style={{ color: THEME.heading, textDecoration: "underline" }}
              >
                openrouter.ai/keys
              </a>
              , then press Save + Test.
            </p>
          ) : null}
          {isError && !showCountdown ? (
            <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
              <button type="button" onClick={() => void handleTestAndSave()} disabled={busy} style={buttonStyle}>
                Retry test
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/**
 * Default model + aspect preferences (localStorage only).
 * Kept in this file so settings/page.tsx stays a server component with SEO metadata.
 */
const MODEL_STORAGE_KEY = "vidiomaker.model";
const ASPECT_STORAGE_KEY = "vidiomaker.aspect";

export function SettingsPrefs(): React.ReactElement {
  const [defaultModel, setDefaultModel] = useState("");
  const [aspect, setAspect] = useState("1080x1920");
  const [savedNote, setSavedNote] = useState<string | null>(null);

  useEffect(() => {
    try {
      setDefaultModel(window.localStorage.getItem(MODEL_STORAGE_KEY) ?? "");
      setAspect(window.localStorage.getItem(ASPECT_STORAGE_KEY) ?? "1080x1920");
    } catch {
      // Storage unavailable — defaults stand.
    }
  }, []);

  function persist() {
    try {
      if (defaultModel.trim()) {
        window.localStorage.setItem(MODEL_STORAGE_KEY, defaultModel.trim());
      } else {
        window.localStorage.removeItem(MODEL_STORAGE_KEY);
      }
      window.localStorage.setItem(ASPECT_STORAGE_KEY, aspect);
      setSavedNote("Preferences saved in this browser.");
    } catch {
      setSavedNote("Could not save preferences (storage unavailable).");
    }
  }

  const fieldStyle: React.CSSProperties = {
    width: "100%",
    minHeight: 44,
    padding: "10px 12px",
    borderRadius: 8,
    border: `1px solid ${THEME.border}`,
    background: THEME.card,
    color: THEME.text,
    fontSize: 16,
    boxSizing: "border-box",
  };

  return (
    <section
      aria-label="Default model and aspect preferences"
      style={{
        background: THEME.background,
        color: THEME.text,
        border: `1px solid ${THEME.border}`,
        borderRadius: 12,
        padding: 16,
        width: "100%",
        maxWidth: 720,
      }}
    >
      <h2 style={{ color: THEME.heading, margin: "0 0 8px", fontSize: 20 }}>Defaults</h2>
      <p style={{ color: THEME.muted, margin: "0 0 16px", fontSize: 14, lineHeight: 1.5 }}>
        Pick the live model list on the <a href="/create" style={{ color: THEME.heading }}>Create</a> page —
        your choice is remembered here. Aspect defaults to vertical 1080×1920 for Shorts/Reels/TikTok.
      </p>

      <label htmlFor="default-model" style={{ display: "block", marginBottom: 8, fontSize: 14 }}>
        Default model id
      </label>
      <input
        id="default-model"
        type="text"
        value={defaultModel}
        onChange={(event) => setDefaultModel(event.target.value)}
        placeholder="e.g. openai/gpt-4o-mini (choose from Create → OpenRouter)"
        autoComplete="off"
        spellCheck={false}
        style={fieldStyle}
      />

      <label htmlFor="aspect-pref" style={{ display: "block", margin: "16px 0 8px", fontSize: 14 }}>
        Default aspect
      </label>
      <select
        id="aspect-pref"
        value={aspect}
        onChange={(event) => setAspect(event.target.value)}
        style={fieldStyle}
      >
        <option value="1080x1920">1080×1920 vertical (Shorts / Reels / TikTok)</option>
        <option value="1920x1080">1920×1080 horizontal (YouTube)</option>
      </select>

      <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={persist}
          style={{
            minHeight: 44,
            padding: "10px 20px",
            borderRadius: 8,
            border: `1px solid ${THEME.border}`,
            background: THEME.button,
            color: THEME.heading,
            fontSize: 16,
            cursor: "pointer",
          }}
        >
          Save defaults
        </button>
      </div>
      {savedNote ? (
        <p role="status" style={{ color: THEME.muted, fontSize: 14, margin: "12px 0 0" }}>
          {savedNote}
        </p>
      ) : null}
    </section>
  );
}
