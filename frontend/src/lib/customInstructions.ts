/**
 * Custom Instructions & Creative Control — localStorage persistence.
 * Keys are browser-only (never committed); backend receives the values
 * per-request as snake_case body fields (see lib/api.ts).
 */

import {
  DEFAULT_LANGUAGE,
  MAX_CUSTOM_INSTRUCTIONS_LENGTH,
} from "./types";

export const CUSTOM_INSTRUCTIONS_KEY = "vidiomaker.custom_instructions";
export const STYLE_PRESET_KEY = "vidiomaker.style_preset";
export const TONE_KEY = "vidiomaker.tone";
export const LANGUAGE_KEY = "vidiomaker.language";
export const TARGET_AUDIENCE_KEY = "vidiomaker.target_audience";

export interface CustomInstructionsState {
  customInstructions: string;
  stylePreset: string;
  tone: string;
  language: string;
  targetAudience: string;
}

export const EMPTY_CUSTOM_INSTRUCTIONS: CustomInstructionsState = {
  customInstructions: "",
  stylePreset: "",
  tone: "",
  language: DEFAULT_LANGUAGE,
  targetAudience: "",
};

function readKey(key: string, fallback = ""): string {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return typeof raw === "string" ? raw : fallback;
  } catch {
    return fallback;
  }
}

function writeKey(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    if (value.trim().length === 0) {
      // Empty style/tone/audience are removed so "no preference" stays empty;
      // language falls back to the default instead of an empty string.
      if (key === LANGUAGE_KEY) {
        window.localStorage.setItem(key, DEFAULT_LANGUAGE);
      } else {
        window.localStorage.removeItem(key);
      }
      return;
    }
    window.localStorage.setItem(key, value);
  } catch {
    // Storage unavailable (private mode) — caller keeps in-memory state.
  }
}

/** Plain-text only: strip HTML tags before persisting (XSS rule). */
export function sanitizeInstructions(value: string): string {
  return value
    .replace(/<[^>]*>/g, "")
    .slice(0, MAX_CUSTOM_INSTRUCTIONS_LENGTH);
}

/** Load saved creative-control defaults (Settings page writes these too). */
export function loadCustomInstructions(): CustomInstructionsState {
  return {
    customInstructions: readKey(CUSTOM_INSTRUCTIONS_KEY),
    stylePreset: readKey(STYLE_PRESET_KEY),
    tone: readKey(TONE_KEY),
    language: readKey(LANGUAGE_KEY, DEFAULT_LANGUAGE) || DEFAULT_LANGUAGE,
    targetAudience: readKey(TARGET_AUDIENCE_KEY),
  };
}

/** Persist creative-control defaults (Save as default / wizard autosave). */
export function saveCustomInstructions(
  state: CustomInstructionsState,
): void {
  writeKey(
    CUSTOM_INSTRUCTIONS_KEY,
    sanitizeInstructions(state.customInstructions).trim(),
  );
  writeKey(STYLE_PRESET_KEY, state.stylePreset.trim().slice(0, 100));
  writeKey(TONE_KEY, state.tone.trim().slice(0, 100));
  const language = state.language.trim().slice(0, 100) || DEFAULT_LANGUAGE;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(LANGUAGE_KEY, language);
    } catch {
      // Ignore storage errors.
    }
  }
  writeKey(TARGET_AUDIENCE_KEY, state.targetAudience.trim().slice(0, 100));
}

/** Remove all saved creative-control defaults. */
export function clearCustomInstructions(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(CUSTOM_INSTRUCTIONS_KEY);
    window.localStorage.removeItem(STYLE_PRESET_KEY);
    window.localStorage.removeItem(TONE_KEY);
    window.localStorage.setItem(LANGUAGE_KEY, DEFAULT_LANGUAGE);
    window.localStorage.removeItem(TARGET_AUDIENCE_KEY);
  } catch {
    // Ignore storage errors.
  }
}
