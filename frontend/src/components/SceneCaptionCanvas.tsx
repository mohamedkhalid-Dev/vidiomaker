"use client";

import { useEffect, useRef } from "react";
import {
  captionLayout,
  cleanCaptionText,
  drawCaptionLines,
  wrapCaptionLines,
} from "../lib/render";

/**
 * Live WYSIWYG caption preview — the SAME Canvas 2D text path the final
 * MP4 uses (lib/render.ts drawCaptionLines), so what you edit is what
 * gets burned into the video.
 *
 * - Draws the scene image cover-fit + narration bottom-center (white fill,
 *   black stroke, translucent backdrop) directly onto <canvas>.
 * - Editable: pass onNarrationChange to get a textarea bound to the same
 *   state that startRender() reads — edits update the canvas instantly
 *   AND flow into the final MP4 (no re-generate needed).
 *
 * Preview canvas is 1/3 scale (360x640 / 640x360) for speed; drawing happens
 * in full 1080x1920 space under a scale transform so font geometry matches
 * the final render exactly.
 */

export type CaptionAspect = "1080x1920" | "1920x1080";

export interface SceneCaptionCanvasProps {
  imageUrl?: string | null;
  narration?: string | null;
  aspect?: CaptionAspect;
  /** Scene index for accessible labels (0-based). */
  sceneIdx?: number;
  /** When provided, an editable textarea is shown and edits call this. */
  onNarrationChange?: (next: string) => void;
  /** Show the textarea even when onNarrationChange is omitted. Default false. */
  editable?: boolean;
}

const FULL_W_VERTICAL = 1080;
const FULL_H_VERTICAL = 1920;
const FULL_W_HORIZONTAL = 1920;
const FULL_H_HORIZONTAL = 1080;

/**
 * Agent 5 — CORS-aware preview loading for library images.
 *
 * Two-tier strategy (preview never reads pixels back, so a tainted canvas
 * is perfectly displayable):
 * 1. `crossOrigin="anonymous"` first — works when the host sends CORS
 *    headers (Supabase Storage does: `Access-Control-Allow-Origin: *`).
 * 2. On failure, retry WITHOUT the crossOrigin attribute — the image
 *    displays fine (tainted), it just can't be read back via getImageData
 *    (which this preview never does).
 * Both tiers failing (broken URL, host down) paints black + caption, so a
 * dead library URL can never hide the narration text.
 *
 * `pendingLoads` dedupes concurrent mounts of the same URL (Images grid +
 * Script step + Video step mount the same still) — one network fetch, and
 * the browser HTTP cache serves repeat visits (caching). Use
 * `preloadSceneImage()` to warm the cache ahead of mounting (preload).
 */
const pendingLoads = new Map<string, Promise<HTMLImageElement | null>>();

function loadPreviewImage(url: string): Promise<HTMLImageElement | null> {
  const hit = pendingLoads.get(url);
  if (hit) return hit;
  const task = new Promise<HTMLImageElement | null>((resolve) => {
    const first = new Image();
    first.crossOrigin = "anonymous";
    first.onload = () => resolve(first);
    first.onerror = () => {
      // Fallback: tainted-but-displayable (no CORS headers on host).
      const second = new Image();
      second.onload = () => resolve(second);
      second.onerror = () => resolve(null);
      second.src = url;
    };
    first.src = url;
  });
  pendingLoads.set(url, task);
  // Evict settled entries so a later retry (after a transient failure)
  // re-probes instead of reusing a stale null; successes stay warm via
  // the browser HTTP cache.
  void task.then((img) => {
    if (!img) pendingLoads.delete(url);
  });
  return task;
}

/**
 * Warm the preview cache for a library URL before its card mounts
 * (Images step Replace flow). Never throws; false = broken URL.
 */
export async function preloadSceneImage(url: string): Promise<boolean> {
  const clean = (url ?? "").trim();
  if (clean.length === 0) return false;
  if (clean.startsWith("blob:") || clean.startsWith("data:")) return true;
  const img = await loadPreviewImage(clean);
  return img !== null;
}

function previewSize(aspect: CaptionAspect): { w: number; h: number } {
  return aspect === "1920x1080" ? { w: 480, h: 270 } : { w: 270, h: 480 };
}

export default function SceneCaptionCanvas({
  imageUrl = null,
  narration = "",
  aspect = "1080x1920",
  sceneIdx = 0,
  onNarrationChange,
  editable = false,
}: SceneCaptionCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const canEdit = typeof onNarrationChange === "function" || editable;
  const text = narration ?? "";

  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const horizontal = aspect === "1920x1080";
    const fullW = horizontal ? FULL_W_HORIZONTAL : FULL_W_VERTICAL;
    const fullH = horizontal ? FULL_H_HORIZONTAL : FULL_H_VERTICAL;
    const scale = canvas.width / fullW;

    const paint = (img: HTMLImageElement | null): void => {
      if (cancelled) return;
      // Full-res coordinate space, scaled down for preview speed.
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, fullW, fullH);
      if (img && img.naturalWidth > 0) {
        const base = Math.max(fullW / img.naturalWidth, fullH / img.naturalHeight);
        const dw = img.naturalWidth * base;
        const dh = img.naturalHeight * base;
        ctx.drawImage(img, (fullW - dw) / 2, (fullH - dh) / 2, dw, dh);
      }
      // Same wrap + draw path as the MP4 recorder (pre-wrap here is fine
      // for a single static frame; the recorder pre-wraps once per scene).
      const clean = cleanCaptionText(text);
      if (clean.length > 0) {
        const { maxWidth, font } = captionLayout(fullW, fullH);
        ctx.font = font;
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        const lines = wrapCaptionLines(ctx, clean, maxWidth, 5);
        drawCaptionLines(ctx, lines, fullW, fullH);
      }
      // Reset so future reads are in device pixels.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    };

    const url = (imageUrl ?? "").trim();
    // Paint text immediately on the designated page canvas (black base +
    // caption) so the caption is visible even while the image is loading;
    // repaint with the image once it arrives. Single canvas, image FIRST,
    // text AFTER — same order as the MP4 recorder.
    paint(null);
    if (!url) {
      return;
    }
    // blob:/data: URLs are same-origin — plain load, no CORS tiers needed.
    if (url.startsWith("blob:") || url.startsWith("data:")) {
      const img = new Image();
      img.onload = () => paint(img);
      img.onerror = () => paint(null);
      img.src = url;
      return () => {
        cancelled = true;
        img.onload = null;
        img.onerror = null;
      };
    }
    let settled = false;
    void loadPreviewImage(url).then((img) => {
      if (!cancelled && !settled) {
        settled = true;
        paint(img);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [imageUrl, text, aspect]);

  const { w, h } = previewSize(aspect);

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <canvas
        ref={canvasRef}
        width={w}
        height={h}
        role="img"
        aria-label={
          text.trim().length > 0
            ? `Scene ${sceneIdx + 1} preview with caption: ${text.slice(0, 120)}`
            : `Scene ${sceneIdx + 1} preview (no caption)`
        }
        style={{
          width: "100%",
          maxWidth: aspect === "1920x1080" ? 480 : 270,
          margin: "0 auto",
          aspectRatio: aspect === "1920x1080" ? "16 / 9" : "9 / 16",
          borderRadius: 10,
          border: "1px solid #2A2A2A",
          background: "#000",
          display: "block",
        }}
      />
      {canEdit && onNarrationChange ? (
        <label
          htmlFor={`caption-edit-${sceneIdx}`}
          style={{ display: "grid", gap: 4, fontSize: 13, color: "#808080" }}
        >
          <span>Caption on video — scene {sceneIdx + 1} (edit me, updates video)</span>
          <textarea
            id={`caption-edit-${sceneIdx}`}
            value={text}
            rows={2}
            maxLength={500}
            onChange={(e) => onNarrationChange(e.target.value)}
            placeholder="Type what appears on this image…"
            style={{
              width: "100%",
              minHeight: 44,
              padding: "10px 12px",
              borderRadius: 8,
              border: "1px solid #2A2A2A",
              background: "#000",
              color: "#B8B8B8",
              fontSize: 14,
              lineHeight: 1.5,
              boxSizing: "border-box",
              resize: "vertical",
            }}
          />
        </label>
      ) : null}
    </div>
  );
}
