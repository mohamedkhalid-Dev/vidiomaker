"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { VideoAspect, VideoOptions } from "../lib/types";
import {
  MAX_SCENE_COUNT,
  MAX_SCENE_DURATION,
  MIN_SCENE_COUNT,
  MIN_SCENE_DURATION,
  loadTopicDraft,
  saveTopicDraft,
} from "../lib/types";

// Re-export for consumers that import the type from the component.
export type { VideoAspect, VideoOptions } from "../lib/types";

export interface TopicInputProps {
  initialTopic?: string;
  initialOptions?: Partial<VideoOptions>;
  isSubmitting?: boolean;
  onSubmit: (topic: string, opts: VideoOptions) => void;
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

const EMPTY_TOPIC_MESSAGE = "Please describe your video idea first.";

const SCENE_COUNT_OPTIONS = Array.from(
  { length: MAX_SCENE_COUNT - MIN_SCENE_COUNT + 1 },
  (_, i) => MIN_SCENE_COUNT + i,
);

const DURATION_OPTIONS = Array.from(
  { length: MAX_SCENE_DURATION - MIN_SCENE_DURATION + 1 },
  (_, i) => MIN_SCENE_DURATION + i,
);

const CONTROL_STYLE: React.CSSProperties = {
  width: "100%",
  minHeight: 44,
  background: THEME.background,
  color: THEME.text,
  border: `1px solid ${THEME.border}`,
  borderRadius: 8,
  padding: "0.65rem 0.75rem",
  fontSize: "1rem",
  boxSizing: "border-box",
};

const PRIMARY_CTA_STYLE: React.CSSProperties = {
  background: "#E8E8E8",
  color: "#000",
  border: "1px solid #E8E8E8",
  borderRadius: 8,
  minHeight: 48,
  minWidth: 44,
  width: "100%",
  padding: "0.75rem 1.1rem",
  fontSize: "1rem",
  fontWeight: 700,
};

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const rounded = Math.round(value);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

export default function TopicInput({
  initialTopic = "",
  initialOptions = {},
  isSubmitting = false,
  onSubmit,
}: TopicInputProps): React.ReactElement {
  // Draft restore: explicit props (last submitted wizard values) win;
  // otherwise fall back to the localStorage draft so a reload keeps
  // "Describe your idea" + "Video settings (optional)".
  function getStoredDraft(): { topic: string; opts: Partial<VideoOptions> } {
    try {
      const draft = loadTopicDraft();
      return { topic: draft.topic, opts: draft.options };
    } catch {
      return { topic: "", opts: {} };
    }
  }

  const [topic, setTopic] = useState(() => {
    if (initialTopic.trim().length > 0) return initialTopic;
    return getStoredDraft().topic;
  });
  const [negativePrompt, setNegativePrompt] = useState(() => {
    if (initialOptions.negativePrompt !== undefined)
      return initialOptions.negativePrompt ?? "";
    return getStoredDraft().opts.negativePrompt ?? "";
  });
  const [sceneCount, setSceneCount] = useState(() =>
    clampInt(
      initialOptions.sceneCount ?? getStoredDraft().opts.sceneCount ?? 5,
      MIN_SCENE_COUNT,
      MAX_SCENE_COUNT,
      5,
    ),
  );
  const [duration, setDuration] = useState(() =>
    clampInt(
      initialOptions.duration ?? getStoredDraft().opts.duration ?? 5,
      MIN_SCENE_DURATION,
      MAX_SCENE_DURATION,
      5,
    ),
  );
  const [aspect, setAspect] = useState<VideoAspect>(() => {
    const fromProps = initialOptions.aspect;
    if (fromProps === "1920x1080" || fromProps === "1080x1920")
      return fromProps;
    const stored = getStoredDraft().opts.aspect;
    return stored === "1920x1080" ? "1920x1080" : "1080x1920";
  });
  const [error, setError] = useState<string | null>(null);

  // Autosave the draft on every change — reload-safe, no button needed.
  useEffect(() => {
    const cleanNegative = negativePrompt.trim();
    saveTopicDraft(topic, {
      sceneCount,
      duration,
      aspect,
      ...(cleanNegative.length > 0 ? { negativePrompt: cleanNegative } : {}),
    });
  }, [topic, negativePrompt, sceneCount, duration, aspect]);

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const cleanTopic = topic.trim();
    if (cleanTopic.length === 0) {
      // Inline friendly validation — never a 500 or blank screen.
      setError(EMPTY_TOPIC_MESSAGE);
      return;
    }
    setError(null);
    const cleanNegative = negativePrompt.trim();
    const opts: VideoOptions = {
      sceneCount,
      duration,
      aspect,
      ...(cleanNegative.length > 0 ? { negativePrompt: cleanNegative } : {}),
    };
    onSubmit(cleanTopic, opts);
  }

  // Plain-language summary for the collapsed settings (defaults pre-selected).
  const settingsSummary = `${sceneCount} scenes · ${duration}s each · ${
    aspect === "1920x1080" ? "Horizontal" : "Vertical"
  }${negativePrompt.trim() ? " · avoids added" : ""}`;

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      aria-label="Describe your video"
      style={{
        background: THEME.card,
        border: `1px solid ${THEME.border}`,
        borderRadius: 12,
        padding: "1rem",
        display: "grid",
        gap: "0.9rem",
        maxWidth: 640,
        width: "100%",
        boxSizing: "border-box",
      }}
    >
      <h2 style={{ color: THEME.heading, margin: 0, fontSize: 20 }}>
        What is your video about?
      </h2>
      <p
        id="vidiomaker-topic-help"
        style={{ color: THEME.muted, margin: 0, fontSize: 14, lineHeight: 1.5 }}
      >
        Type one idea in plain words. Defaults already work — press Generate
        when ready.
      </p>

      <div style={{ display: "grid", gap: "0.4rem" }}>
        <label htmlFor="vidiomaker-topic" style={{ color: THEME.heading, fontWeight: 600 }}>
          Your idea
        </label>
        <textarea
          id="vidiomaker-topic"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="Example: a lonely robot finds a secret garden…"
          rows={4}
          aria-describedby={`vidiomaker-topic-help${error ? " vidiomaker-topic-error" : ""}`}
          aria-invalid={error ? true : undefined}
          style={{ ...CONTROL_STYLE, resize: "vertical", lineHeight: 1.5 }}
        />
      </div>

      {error ? (
        <p
          id="vidiomaker-topic-error"
          role="alert"
          style={{ color: "#D4A0A0", margin: 0, lineHeight: 1.5 }}
        >
          {error} Try: “a brave kid explores a glowing cave”.
        </p>
      ) : null}

      <button
        type="submit"
        disabled={isSubmitting}
        style={{
          ...PRIMARY_CTA_STYLE,
          cursor: isSubmitting ? "not-allowed" : "pointer",
          opacity: isSubmitting ? 0.6 : 1,
        }}
      >
        {isSubmitting ? "Writing your script…" : "Generate my script →"}
      </button>

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
            fontSize: 15,
            fontWeight: 600,
          }}
        >
          Video settings (optional) — {settingsSummary}
        </summary>
        <div style={{ display: "grid", gap: "0.9rem", marginTop: "0.75rem" }}>
          <div style={{ display: "grid", gap: "0.4rem" }}>
            <label htmlFor="vidiomaker-negative" style={{ color: THEME.heading }}>
              Words to avoid{" "}
              <span style={{ color: THEME.muted, fontWeight: 400 }}>(optional)</span>
            </label>
            <p style={{ color: THEME.muted, fontSize: 13, margin: 0, lineHeight: 1.5 }}>
              Things you don&apos;t want to see, e.g. blurry, watermark.
            </p>
            <input
              id="vidiomaker-negative"
              type="text"
              value={negativePrompt}
              onChange={(e) => setNegativePrompt(e.target.value)}
              placeholder="blurry, watermark, low quality"
              autoComplete="off"
              style={CONTROL_STYLE}
            />
          </div>

          <div
            style={{
              display: "grid",
              gap: "0.9rem",
              gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
            }}
          >
            <div style={{ display: "grid", gap: "0.4rem" }}>
              <label htmlFor="vidiomaker-scenes" style={{ color: THEME.heading }}>
                How many scenes?
              </label>
              <select
                id="vidiomaker-scenes"
                value={sceneCount}
                onChange={(e) =>
                  setSceneCount(
                    clampInt(
                      Number(e.target.value),
                      MIN_SCENE_COUNT,
                      MAX_SCENE_COUNT,
                      5,
                    ),
                  )
                }
                style={CONTROL_STYLE}
              >
                {SCENE_COUNT_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n} scenes
                  </option>
                ))}
              </select>
            </div>

            <div style={{ display: "grid", gap: "0.4rem" }}>
              <label htmlFor="vidiomaker-duration" style={{ color: THEME.heading }}>
                Length of each scene
              </label>
              <select
                id="vidiomaker-duration"
                value={duration}
                onChange={(e) =>
                  setDuration(
                    clampInt(
                      Number(e.target.value),
                      MIN_SCENE_DURATION,
                      MAX_SCENE_DURATION,
                      5,
                    ),
                  )
                }
                style={CONTROL_STYLE}
              >
                {DURATION_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n} seconds
                  </option>
                ))}
              </select>
            </div>

            <div style={{ display: "grid", gap: "0.4rem" }}>
              <label htmlFor="vidiomaker-aspect" style={{ color: THEME.heading }}>
                Video shape
              </label>
              <select
                id="vidiomaker-aspect"
                value={aspect}
                onChange={(e) => setAspect(e.target.value as VideoAspect)}
                style={CONTROL_STYLE}
              >
                <option value="1080x1920">Vertical (Shorts / TikTok)</option>
                <option value="1920x1080">Horizontal (YouTube)</option>
              </select>
            </div>
          </div>
          <p style={{ color: THEME.muted, fontSize: 13, margin: 0, lineHeight: 1.5 }}>
            Tip: 5 scenes × 5 seconds ≈ a 25-second video. Vertical fits phones.
          </p>
        </div>
      </details>
    </form>
  );
}
