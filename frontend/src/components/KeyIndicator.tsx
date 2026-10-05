"use client";

import { useEffect, useState } from "react";
import { API_KEY_STORAGE_KEY } from "../lib/openrouter";
import { KEY_CHANGE_EVENT } from "./SettingsApiKey";

/**
 * Header key indicator (client island inside the server RootLayout).
 * Reads localStorage only — never touches the network, never logs the key.
 * Listens to `storage` (cross-tab) + `vidiomaker:key-change` (same-tab save/clear).
 */
export default function KeyIndicator(): React.ReactElement {
  const [hasKey, setHasKey] = useState<boolean | null>(null);

  useEffect(() => {
    function refresh() {
      try {
        const stored = window.localStorage.getItem(API_KEY_STORAGE_KEY);
        setHasKey(!!stored && stored.trim().length > 0);
      } catch {
        setHasKey(false);
      }
    }
    refresh();
    window.addEventListener("storage", refresh);
    window.addEventListener(KEY_CHANGE_EVENT, refresh);
    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener(KEY_CHANGE_EVENT, refresh);
    };
  }, []);

  // Render the Agent 1 placeholder shape on first paint (avoids hydration mismatch).
  if (hasKey === null) {
    return (
      <span id="key-indicator" className="key-indicator" aria-live="polite">
        ○ No key
      </span>
    );
  }

  return (
    <span
      id="key-indicator"
      className="key-indicator"
      aria-live="polite"
      title={hasKey ? "OpenRouter API key is set in this browser" : "No OpenRouter API key saved"}
    >
      {hasKey ? "● Key set" : "○ No key"}
    </span>
  );
}
