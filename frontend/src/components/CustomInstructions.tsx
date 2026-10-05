"use client";

import { LANGUAGES, STYLE_PRESETS, TONES } from "../lib/types";

export interface CustomInstructionsValue {
  customInstructions: string;
  stylePreset: string;
  tone: string;
  language: string;
  targetAudience: string;
}

export const EMPTY_CUSTOM_VALUE: CustomInstructionsValue = {
  customInstructions: "",
  stylePreset: "",
  tone: "",
  language: "English",
  targetAudience: "",
};

export interface CustomInstructionsProps {
  value: CustomInstructionsValue;
  onChange: (next: CustomInstructionsValue) => void;
  onSaveDefault?: () => void;
  onClear?: () => void;
  idPrefix?: string;
  /** Start expanded. Defaults to false so the wizard stays simple. */
  defaultOpen?: boolean;
}

const THEME = {
  background: "#000",
  text: "#B8B8B8",
  muted: "#9E9E9E",
  card: "#111",
  border: "#2A2A2A",
  button: "#1A1A1A",
  heading: "#D4D4D4",
} as const;

const CONTROL_STYLE: React.CSSProperties = {
  width: "100%",
  minHeight: 44,
  background: "#000",
  color: "#B8B8B8",
  border: "1px solid #2A2A2A",
  borderRadius: 8,
  padding: "0.65rem 0.75rem",
  fontSize: "1rem",
  boxSizing: "border-box",
};

const BUTTON_STYLE: React.CSSProperties = {
  minHeight: 44,
  minWidth: 44,
  padding: "0.65rem 1.1rem",
  borderRadius: 8,
  border: "1px solid #2A2A2A",
  background: "#1A1A1A",
  color: "#B8B8B8",
  fontSize: "1rem",
  cursor: "pointer",
};

export default function CustomInstructions({
  value,
  onChange,
  onSaveDefault,
  onClear,
  idPrefix = "ci",
  defaultOpen = false,
}: CustomInstructionsProps): React.ReactElement {
  const remaining = 500 - value.customInstructions.length;
  const hasCustom = value.customInstructions.trim().length > 0 || value.stylePreset.trim().length > 0;
  const summaryText = hasCustom
    ? `Story style — ${value.stylePreset || "custom"} ✓`
    : "Story style (optional) — default works fine";

  const body = (
    <>
      <div style={{ display: "grid", gap: "0.4rem" }}>
        <label htmlFor={`${idPrefix}-instructions`} style={{ color: THEME.heading }}>
          How should it sound?{" "}
          <span style={{ color: THEME.muted, fontWeight: 400 }}>(optional)</span>
        </label>
        <p style={{ color: THEME.muted, fontSize: 13, margin: 0, lineHeight: 1.5 }}>
          Example: fast and funny for kids. Leave blank for a plain voice.
        </p>
        <textarea
          id={`${idPrefix}-instructions`}
          value={value.customInstructions}
          onChange={(e) =>
            onChange({
              ...value,
              customInstructions: e.target.value.slice(0, 500),
            })
          }
          placeholder="Example: fast-paced, funny, ends with a twist"
          rows={3}
          maxLength={500}
          aria-describedby={`${idPrefix}-counter`}
          style={{ ...CONTROL_STYLE, resize: "vertical", lineHeight: 1.5 }}
        />
        <p
          id={`${idPrefix}-counter`}
          aria-live="polite"
          style={{ color: THEME.muted, fontSize: 12, margin: 0 }}
        >
          {value.customInstructions.length}/500 ({remaining} left)
        </p>
      </div>

      <div style={{ display: "grid", gap: "0.4rem" }}>
        <span id={`${idPrefix}-style-label`} style={{ color: THEME.heading }}>
          Pick a look
        </span>
        <div
          role="group"
          aria-labelledby={`${idPrefix}-style-label`}
          style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
        >
          {STYLE_PRESETS.map((preset) => {
            const active = value.stylePreset === preset;
            return (
              <button
                key={preset}
                type="button"
                aria-pressed={active}
                onClick={() =>
                  onChange({
                    ...value,
                    stylePreset: active ? "" : preset,
                  })
                }
                style={{
                  ...BUTTON_STYLE,
                  borderColor: active ? THEME.heading : THEME.border,
                  color: active ? THEME.heading : THEME.text,
                }}
              >
                {preset}
              </button>
            );
          })}
        </div>
        <label htmlFor={`${idPrefix}-style-select`} style={{ color: THEME.muted, fontSize: 13 }}>
          Or pick from the list (same choice, easier on phones):
        </label>
        <select
          id={`${idPrefix}-style-select`}
          value={value.stylePreset}
          onChange={(e) => onChange({ ...value, stylePreset: e.target.value })}
          style={CONTROL_STYLE}
        >
          <option value="">No look (default)</option>
          {STYLE_PRESETS.map((preset) => (
            <option key={preset} value={preset}>
              {preset}
            </option>
          ))}
        </select>
      </div>

      <details
        style={{
          border: `1px solid ${THEME.border}`,
          borderRadius: 8,
          padding: "0.6rem 0.75rem",
        }}
      >
        <summary
          style={{
            cursor: "pointer",
            minHeight: 44,
            display: "flex",
            alignItems: "center",
            color: THEME.heading,
          }}
        >
          More: tone, language, audience
        </summary>
        <div style={{ display: "grid", gap: "0.9rem", marginTop: "0.75rem" }}>
          <div style={{ display: "grid", gap: "0.4rem" }}>
            <label htmlFor={`${idPrefix}-tone`} style={{ color: THEME.heading }}>
              Tone
            </label>
            <select
              id={`${idPrefix}-tone`}
              value={value.tone}
              onChange={(e) => onChange({ ...value, tone: e.target.value })}
              style={CONTROL_STYLE}
            >
              <option value="">No preference (default)</option>
              {TONES.map((tone) => (
                <option key={tone} value={tone}>
                  {tone}
                </option>
              ))}
            </select>
          </div>
          <div style={{ display: "grid", gap: "0.4rem" }}>
            <label htmlFor={`${idPrefix}-language`} style={{ color: THEME.heading }}>
              Language
            </label>
            <select
              id={`${idPrefix}-language`}
              value={value.language || "English"}
              onChange={(e) => onChange({ ...value, language: e.target.value })}
              style={CONTROL_STYLE}
            >
              {LANGUAGES.map((language) => (
                <option key={language} value={language}>
                  {language}
                </option>
              ))}
            </select>
          </div>
          <div style={{ display: "grid", gap: "0.4rem" }}>
            <label htmlFor={`${idPrefix}-audience`} style={{ color: THEME.heading }}>
              Who is it for?
            </label>
            <input
              id={`${idPrefix}-audience`}
              type="text"
              value={value.targetAudience}
              onChange={(e) =>
                onChange({
                  ...value,
                  targetAudience: e.target.value.slice(0, 100),
                })
              }
              placeholder="Example: teens on TikTok"
              autoComplete="off"
              maxLength={100}
              style={CONTROL_STYLE}
            />
          </div>
        </div>
      </details>

      {onSaveDefault || onClear ? (
        <p style={{ color: THEME.muted, fontSize: 13, margin: 0, lineHeight: 1.5 }}>
          Saved automatically in this browser — used for every new video.
        </p>
      ) : null}
      {onSaveDefault || onClear ? (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {onSaveDefault ? (
            <button type="button" onClick={onSaveDefault} style={BUTTON_STYLE}>
              Save as default
            </button>
          ) : null}
          {onClear ? (
            <button type="button" onClick={onClear} style={BUTTON_STYLE}>
              Clear
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );

  return (
    <div
      style={{
        background: THEME.card,
        border: `1px solid ${THEME.border}`,
        borderRadius: 12,
        padding: "1rem",
        display: "grid",
        gap: "0.9rem",
        width: "100%",
        boxSizing: "border-box",
      }}
    >
      <details open={defaultOpen} style={{ display: "grid", gap: "0.9rem" }}>
        <summary
          style={{
            cursor: "pointer",
            minHeight: 44,
            display: "flex",
            alignItems: "center",
            color: THEME.heading,
            fontWeight: 600,
            fontSize: 16,
          }}
        >
          {summaryText}
        </summary>
        <div style={{ display: "grid", gap: "0.9rem", marginTop: "0.75rem" }}>
          {body}
        </div>
      </details>
    </div>
  );
}
