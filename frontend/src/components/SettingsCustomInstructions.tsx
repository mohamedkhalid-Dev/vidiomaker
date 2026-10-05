"use client";

import { useEffect, useState } from "react";
import CustomInstructions, {
  EMPTY_CUSTOM_VALUE,
  type CustomInstructionsValue,
} from "./CustomInstructions";
import {
  clearCustomInstructions,
  loadCustomInstructions,
  sanitizeInstructions,
  saveCustomInstructions,
} from "../lib/customInstructions";

const THEME = {
  background: "#000",
  text: "#B8B8B8",
  muted: "#808080",
  card: "#111",
  border: "#2A2A2A",
  heading: "#D4D4D4",
} as const;

/**
 * Settings island: global creative-control defaults persisted to
 * localStorage (vidiomaker.custom_instructions etc). The Create wizard
 * hydrates from the same keys, so a default set here applies everywhere
 * until overridden per video.
 */
export default function SettingsCustomInstructions(): React.ReactElement {
  const [value, setValue] = useState<CustomInstructionsValue>(EMPTY_CUSTOM_VALUE);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    const stored = loadCustomInstructions();
    setValue({
      customInstructions: stored.customInstructions,
      stylePreset: stored.stylePreset,
      tone: stored.tone,
      language: stored.language,
      targetAudience: stored.targetAudience,
    });
  }, []);

  function handleSave(): void {
    saveCustomInstructions({
      ...value,
      customInstructions: sanitizeInstructions(value.customInstructions),
    });
    setNote("Creative defaults saved in this browser.");
  }

  function handleClear(): void {
    clearCustomInstructions();
    const stored = loadCustomInstructions();
    setValue({
      customInstructions: stored.customInstructions,
      stylePreset: stored.stylePreset,
      tone: stored.tone,
      language: stored.language,
      targetAudience: stored.targetAudience,
    });
    setNote("Creative defaults cleared.");
  }

  return (
    <section
      aria-label="Creative control defaults"
      style={{
        background: THEME.background,
        color: THEME.text,
        border: `1px solid ${THEME.border}`,
        borderRadius: 12,
        padding: 16,
        width: "100%",
        maxWidth: 720,
        display: "grid",
        gap: 12,
      }}
    >
      <h2 style={{ color: THEME.heading, margin: 0, fontSize: 20 }}>
        Creative control defaults
      </h2>
      <p style={{ color: THEME.muted, margin: 0, fontSize: 14, lineHeight: 1.5 }}>
        Saved in this browser only. New videos start with these values — you can
        still override them per video on the Create page.
      </p>
      <CustomInstructions
        value={value}
        onChange={setValue}
        onSaveDefault={handleSave}
        onClear={handleClear}
        idPrefix="settings-ci"
      />
      {note ? (
        <p role="status" style={{ color: THEME.muted, fontSize: 14, margin: 0 }}>
          {note}
        </p>
      ) : null}
    </section>
  );
}
