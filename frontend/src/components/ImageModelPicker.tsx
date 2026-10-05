"use client";

import { useEffect, useState } from "react";
import {
  CLOUDFLARE_IMAGE_MODELS,
  normalizeImageModel,
  readStoredImageModel,
  storeImageModel,
} from "../lib/cloudflare";

interface ImageModelPickerProps {
  selectedModel?: string;
  onSelect?: (modelId: string) => void;
}

const THEME = {
  background: "#000",
  text: "#B8B8B8",
  muted: "#808080",
  card: "#111",
  border: "#2A2A2A",
  button: "#1A1A1A",
  heading: "#D4D4D4",
} as const;

/**
 * Website image-model picker (Cloudflare Workers AI).
 * Dropdown of the 4 FLUX ids — persists to
 * localStorage `vidiomaker.image_model` and notifies the parent via
 * onSelect so Generate images / Regen / Retry all use the same model.
 */
export default function ImageModelPicker({
  selectedModel,
  onSelect,
}: ImageModelPickerProps): React.ReactElement {
  const [internalSelected, setInternalSelected] = useState<string>(
    CLOUDFLARE_IMAGE_MODELS[0].id
  );

  useEffect(() => {
    setInternalSelected(readStoredImageModel());
  }, []);

  const effectiveSelected = normalizeImageModel(
    selectedModel ?? internalSelected
  );
  const active = CLOUDFLARE_IMAGE_MODELS.find((m) => m.id === effectiveSelected);

  function handleChange(modelId: string): void {
    const clean = normalizeImageModel(modelId);
    setInternalSelected(clean);
    storeImageModel(clean);
    onSelect?.(clean);
  }

  return (
    <section
      aria-label="Image model picker"
      style={{
        background: THEME.background,
        color: THEME.text,
        border: `1px solid ${THEME.border}`,
        borderRadius: 12,
        padding: 16,
        width: "100%",
        maxWidth: 720,
        display: "grid",
        gap: 8,
      }}
    >
      <h2 style={{ color: THEME.heading, margin: 0, fontSize: 20 }}>
        Picture style
      </h2>
      <p id="image-model-help" style={{ color: THEME.muted, margin: 0, fontSize: 14, lineHeight: 1.5 }}>
        Which look for your pictures. Default works for most videos — change
        only if you want a different style.
      </p>
      <label
        htmlFor="image-model-select"
        style={{ display: "block", fontSize: 14 }}
      >
        Picture look (default is fine)
      </label>
      <select
        id="image-model-select"
        value={effectiveSelected}
        onChange={(event) => handleChange(event.target.value)}
        aria-describedby="image-model-help"
        style={{
          width: "100%",
          minHeight: 44,
          padding: "10px 12px",
          borderRadius: 8,
          border: `1px solid ${THEME.border}`,
          background: THEME.card,
          color: THEME.text,
          fontSize: 16,
          boxSizing: "border-box",
        }}
      >
        {CLOUDFLARE_IMAGE_MODELS.map((model) => (
          <option key={model.id} value={model.id}>
            {model.label} — {model.id}
          </option>
        ))}
      </select>
      {active ? (
        <p
          role="status"
          style={{
            margin: 0,
            fontSize: 13,
            color: THEME.muted,
            wordBreak: "break-all",
            lineHeight: 1.5,
          }}
        >
          Selected: {active.id}
          <br />
          {active.hint}
        </p>
      ) : null}
    </section>
  );
}
