"use client";

import { useState } from "react";
import SceneCaptionCanvas, { type CaptionAspect } from "./SceneCaptionCanvas";

/**
 * Stage 3.4 — Editable script scenes + per-scene regenerate + debug log.
 *
 * Contract (per AI_EXECUTION_PLAN Stage 3.4 + Global Rules):
 * - Plain-text rendering only (no HTML injection for user text).
 * - Per-scene Regenerate must NOT wipe other scenes (parent updates single idx).
 * - Black/grey theme, touch targets >= 44px, responsive.
 */

export interface ScriptScene {
  idx: number;
  narration: string;
  imagePrompt: string;
  /** NULL = library-sourced still (no diffusion seed, logged seed=NULL). */
  seed: number | string | null;
  duration: number;
}

export interface ScriptEditorProps {
  scenes: ScriptScene[];
  onChange: (idx: number, patch: Partial<ScriptScene>) => void;
  onRegenerate: (idx: number) => void | Promise<void>;
  /** Model id used for generation — shown in Debug panel (logging rule). */
  modelId?: string;
  /** Video title — shown in Debug panel. */
  title?: string;
  /** Optional controlled regen state (parent may pass; otherwise internal). */
  regeneratingIdx?: number | null;
  /** Optional controlled per-scene errors (parent may pass; merged with local). */
  sceneErrors?: Record<number, string | null>;
  /** Optional scene stills — when present, each scene shows a live Canvas
   * caption preview (same draw path as the MP4) that updates as you type. */
  imageUrls?: Record<number, string>;
  aspect?: CaptionAspect;
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

function badgeStyle(): React.CSSProperties {
  return {
    display: "inline-block",
    border: `1px solid ${THEME.border}`,
    borderRadius: 999,
    padding: "4px 12px",
    fontSize: 13,
    color: THEME.muted,
    background: THEME.background,
    lineHeight: 1.6,
  };
}

function textareaStyle(): React.CSSProperties {
  return {
    width: "100%",
    minHeight: 44,
    padding: "10px 12px",
    borderRadius: 8,
    border: `1px solid ${THEME.border}`,
    background: "#000",
    color: THEME.text,
    fontSize: 15,
    lineHeight: 1.5,
    boxSizing: "border-box",
    resize: "vertical",
  };
}

function buttonStyle(disabled: boolean): React.CSSProperties {
  return {
    minHeight: 44,
    minWidth: 44,
    padding: "10px 20px",
    borderRadius: 8,
    border: `1px solid ${THEME.border}`,
    background: THEME.button,
    color: THEME.heading,
    fontSize: 16,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.6 : 1,
  };
}

export default function ScriptEditor({
  scenes,
  onChange,
  onRegenerate,
  modelId,
  title,
  regeneratingIdx,
  sceneErrors,
  imageUrls,
  aspect = "1080x1920",
}: ScriptEditorProps): React.ReactElement {
  const [internalPending, setInternalPending] = useState<number | null>(null);
  const [internalErrors, setInternalErrors] = useState<Record<number, string>>(
    {},
  );

  // Controlled props win when provided; otherwise fall back to internal state
  // so the spinner + Retry work even if the parent only passes onRegenerate.
  const effectivePending =
    regeneratingIdx !== undefined ? regeneratingIdx : internalPending;

  function errorFor(idx: number): string | null {
    const external = sceneErrors?.[idx];
    if (typeof external === "string" && external.length > 0) return external;
    return internalErrors[idx] ?? null;
  }

  async function handleRegenerate(idx: number): Promise<void> {
    setInternalErrors((prev) => {
      if (!(idx in prev)) return prev;
      const next = { ...prev };
      delete next[idx];
      return next;
    });
    const tracksInternally = regeneratingIdx === undefined;
    if (tracksInternally) setInternalPending(idx);
    try {
      await onRegenerate(idx);
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Could not regenerate this scene. Please retry.";
      // Only track locally when parent has no controlled error slot.
      if (sceneErrors === undefined) {
        setInternalErrors((prev) => ({ ...prev, [idx]: message }));
      }
    } finally {
      if (tracksInternally) setInternalPending(null);
    }
  }

  if (scenes.length === 0) {
    return (
      <section
        aria-label="Script editor"
        style={{
          background: THEME.background,
          color: THEME.text,
          border: `1px solid ${THEME.border}`,
          borderRadius: 12,
          padding: 16,
          width: "100%",
        }}
      >
        <h2 style={{ color: THEME.heading, margin: "0 0 8px", fontSize: 20 }}>
          Script
        </h2>
        <p style={{ color: THEME.muted, margin: 0, lineHeight: 1.5 }}>
          No scenes yet. Go back to Input and press “Generate script” first.
        </p>
      </section>
    );
  }

  return (
    <section
      aria-label="Script editor"
      style={{
        background: THEME.background,
        color: THEME.text,
        border: `1px solid ${THEME.border}`,
        borderRadius: 12,
        padding: 16,
        width: "100%",
        display: "grid",
        gap: 16,
      }}
    >
      <div>
        <h2 style={{ color: THEME.heading, margin: "0 0 4px", fontSize: 20 }}>
          Check your story — fix any words
        </h2>
        <p
          id="script-editor-help"
          style={{ color: THEME.muted, margin: 0, fontSize: 14, lineHeight: 1.5 }}
        >
          {title ? `${title} — ` : ""}{scenes.length} part
          {scenes.length === 1 ? "" : "s"}. Tap any box to edit. Fixing one
          part never changes the others.
        </p>
      </div>

      <ol
        style={{
          listStyle: "none",
          margin: 0,
          padding: 0,
          display: "grid",
          gap: 16,
        }}
      >
        {scenes.map((scene) => {
          const isPending = effectivePending === scene.idx;
          const sceneError = errorFor(scene.idx);
          return (
            <li
              key={scene.idx}
              style={{
                border: `1px solid ${THEME.border}`,
                borderRadius: 10,
                background: THEME.card,
                padding: 14,
                display: "grid",
                gap: 12,
              }}
            >
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <h3
                  style={{
                    color: THEME.heading,
                    margin: 0,
                    fontSize: 16,
                    marginRight: "auto",
                  }}
                >
                  Part {scene.idx + 1} of {scenes.length}
                </h3>
                <span style={badgeStyle()}>Seed: {String(scene.seed)}</span>
                <span style={badgeStyle()}>
                  Duration: {String(scene.duration)}s
                </span>
              </div>

              <div>
                <label
                  htmlFor={`narration-${scene.idx}`}
                  style={{ display: "block", marginBottom: 6, fontSize: 14 }}
                >
                  What viewers hear — also appears as text on the video
                </label>
                <textarea
                  id={`narration-${scene.idx}`}
                  value={scene.narration}
                  rows={3}
                  onChange={(event) =>
                    onChange(scene.idx, { narration: event.target.value })
                  }
                  placeholder="Example: The little robot follows a glowing trail…"
                  aria-describedby="script-editor-help"
                  style={textareaStyle()}
                />
                {/* Live Canvas preview: same text path as the MP4. Updates as
                    you type; only shown once that scene has an image. */}
                {imageUrls?.[scene.idx] ? (
                  <div style={{ marginTop: 8 }}>
                    <SceneCaptionCanvas
                      imageUrl={imageUrls[scene.idx]}
                      narration={scene.narration}
                      aspect={aspect}
                      sceneIdx={scene.idx}
                    />
                  </div>
                ) : null}
              </div>

              <div>
                <label
                  htmlFor={`image-prompt-${scene.idx}`}
                  style={{ display: "block", marginBottom: 6, fontSize: 14 }}
                >
                  What viewers see
                </label>
                <textarea
                  id={`image-prompt-${scene.idx}`}
                  value={scene.imagePrompt}
                  rows={3}
                  onChange={(event) =>
                    onChange(scene.idx, { imagePrompt: event.target.value })
                  }
                  placeholder="Example: cute robot in a green garden, sunny, cinematic…"
                  aria-describedby="script-editor-help"
                  style={textareaStyle()}
                />
              </div>

              <div
                style={{
                  display: "flex",
                  gap: 8,
                  flexWrap: "wrap",
                  alignItems: "center",
                }}
              >
                <button
                  type="button"
                  onClick={() => void handleRegenerate(scene.idx)}
                  disabled={isPending}
                  aria-busy={isPending}
                  aria-label={`Rewrite part ${scene.idx + 1} only`}
                  style={buttonStyle(isPending)}
                >
                  {isPending ? (
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 8,
                      }}
                    >
                      <span
                        aria-hidden="true"
                        style={{
                          width: 14,
                          height: 14,
                          borderRadius: "50%",
                          border: `2px solid ${THEME.muted}`,
                          borderTopColor: THEME.heading,
                          display: "inline-block",
                          animation: "vidiomaker-spin 0.8s linear infinite",
                        }}
                      />
                      Regenerating…
                    </span>
                  ) : (
                    "Rewrite this part"
                  )}
                </button>
              </div>

              {sceneError ? (
                <div
                  role="alert"
                  style={{
                    border: `1px solid ${THEME.border}`,
                    borderRadius: 8,
                    background: THEME.background,
                    padding: "10px 12px",
                    fontSize: 14,
                    lineHeight: 1.5,
                  }}
                >
                  <p style={{ margin: "0 0 8px" }}>{sceneError}</p>
                  <button
                    type="button"
                    onClick={() => void handleRegenerate(scene.idx)}
                    disabled={isPending}
                    style={buttonStyle(isPending)}
                  >
                    Retry
                  </button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>

      {/* Logged prompts/seeds/durations/model_id per video (Global Rule 8). */}
      <details
        style={{
          border: `1px solid ${THEME.border}`,
          borderRadius: 8,
          background: THEME.card,
          padding: "10px 12px",
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
          Debug — logged prompts / seeds / durations
        </summary>
        <div style={{ marginTop: 8, fontSize: 13, lineHeight: 1.6 }}>
          <p style={{ margin: "0 0 8px", color: THEME.muted }}>
            Model: {modelId && modelId.length > 0 ? modelId : "(not recorded)"}
            {title ? ` · Title: ${title}` : ""}
          </p>
          <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 8 }}>
            {scenes.map((scene) => (
              <li key={`debug-${scene.idx}`} style={{ wordBreak: "break-word" }}>
                <span style={{ color: THEME.heading }}>
                  Scene {scene.idx + 1}
                </span>{" "}
                — seed {String(scene.seed)}, duration {String(scene.duration)}s
                <br />
                <span style={{ color: THEME.muted }}>imagePrompt: </span>
                {scene.imagePrompt || "(empty)"}
                <br />
                <span style={{ color: THEME.muted }}>narration: </span>
                {scene.narration || "(empty)"}
              </li>
            ))}
          </ul>
        </div>
      </details>

      <style>{`@keyframes vidiomaker-spin { to { transform: rotate(360deg); } }`}</style>
    </section>
  );
}
