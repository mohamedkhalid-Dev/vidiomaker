"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  VIDEO_STATUS_POLL_INTERVAL_MS,
  fetchVideoStatus,
  pollVideoStatus,
  startRender,
} from "../lib/api";
import { isRateLimitedMessage } from "../lib/errors";
import type { RenderSceneInput } from "../lib/render";
import ErrorAlert from "./ErrorAlert";
import SceneCaptionCanvas from "./SceneCaptionCanvas";

/**
 * Stage 5.5 — Instant CSS Ken Burns preview → final MP4 preview + download.
 *
 * Contract:
 * - While the client-side Canvas + MediaRecorder render runs
 *   (queued/rendering), cycle the scene stills
 *   with a CSS Ken Burns zoom (`@keyframes kenburns` in globals.css, with a
 *   local fallback in PREVIEW_STYLES) so the user gets instant feedback.
 * - Poll the Supabase videos row every 3s; swap to `<video controls
 *   preload="metadata">` as soon as `done` + videoUrl arrive.
 * - Supports vertical 1080x1920 (9:16) + horizontal 1920x1080 (16:9),
 *   mobile-responsive (width 100%, capped max-width).
 * - Plain-text rendering only (no dangerouslySetInnerHTML for user text).
 * - Touch targets >= 44px, loading skeleton, Retry button on failure.
 *
 * Mount in the wizard Video step:
 * ```tsx
 * <VideoPreview
 *   videoId={videoId}
 *   title={videoTitle}
 *   images={sceneImageUrls}
 *   aspect="1080x1920"
 * />
 * ```
 */

export type PreviewAspect = "1080x1920" | "1920x1080";

export interface VideoPreviewProps {
  videoId?: string | null;
  title?: string;
  /** Scene still URLs for the instant preview (ordered). */
  images?: string[];
  /**
   * In-memory scenes (wizard narrations + durations). Passed through to the
   * client-side render; when omitted, scenes load from Supabase, else from
   * `images`. Stills in `images` are always kept, so Retry never loses them.
   */
  scenes?: RenderSceneInput[] | null;
  aspect?: PreviewAspect;
  /** History reuse: known terminal state skips the status fetch. */
  initialStatus?: string | null;
  /** History reuse: known MP4 URL renders `<video>` immediately. */
  initialVideoUrl?: string | null;
  autoRender?: boolean;
  pollIntervalMs?: number;
  onStatusChange?: (status: string) => void;
  onVideoUrl?: (url: string | null) => void;
}

const TERMINAL_STATUSES = new Set(["done", "failed"]);
const ACTIVE_STATUSES = new Set(["queued", "rendering"]);

function statusLabel(status: string): string {
  if (status === "done") return "Done";
  if (status === "failed") return "Failed";
  if (status === "queued") return "Queued…";
  if (status === "rendering") return "Rendering…";
  return "Instant preview";
}

/**
 * Narration for a still, matched by image URL (not by index) so each
 * AI-designated page gets its OWN text even when some scenes still lack
 * images (scenes.length !== stills.length). Falls back to index alignment
 * for legacy callers that pass parallel arrays.
 */
function narrationForStill(
  scenes: RenderSceneInput[] | null | undefined,
  stillUrl: string,
  fallbackIdx: number,
): string {
  if (Array.isArray(scenes)) {
    const cleanStill = stillUrl.trim();
    const direct = scenes.find(
      (s) =>
        s &&
        typeof s.imageUrl === "string" &&
        s.imageUrl.trim().length > 0 &&
        s.imageUrl.trim() === cleanStill &&
        typeof s.narration === "string",
    );
    if (direct && (direct.narration as string).trim().length > 0) {
      return direct.narration as string;
    }
    // Fallback: map the still index to the Nth scene WITH an image (not raw
    // scenes[fallbackIdx] — scenes includes imageless entries while stills
    // does not, so raw indexing returns the wrong scene's text). This keeps
    // Layer 2 (text) aligned to Layer 1 (image) on the same canvas.
    const withImages = scenes.filter(
      (s) =>
        s &&
        typeof s.imageUrl === "string" &&
        s.imageUrl.trim().length > 0,
    );
    const aligned =
      withImages[fallbackIdx] ?? scenes[fallbackIdx];
    if (aligned && typeof aligned.narration === "string") {
      return aligned.narration;
    }
  }
  return "";
}

export default function VideoPreview({
  videoId = null,
  title = "",
  images = [],
  scenes = null,
  aspect = "1080x1920",
  initialStatus = null,
  initialVideoUrl = null,
  autoRender = false,
  pollIntervalMs = VIDEO_STATUS_POLL_INTERVAL_MS,
  onStatusChange,
  onVideoUrl,
}: VideoPreviewProps) {
  const horizontal = aspect === "1920x1080";
  const stills = Array.isArray(images)
    ? images.filter((url) => typeof url === "string" && url.length > 0)
    : [];

  const [status, setStatus] = useState<string>(
    initialStatus ?? (initialVideoUrl ? "done" : "draft"),
  );
  const [videoUrl, setVideoUrl] = useState<string | null>(initialVideoUrl);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [slideIdx, setSlideIdx] = useState(0);
  /** 0–100 local encode progress (null = no render running yet). */
  const [progress, setProgress] = useState<number | null>(null);
  /** Full per-scene failure log, shown in <details> on failed renders. */
  const [sceneLog, setSceneLog] = useState<string | null>(null);
  const pollController = useRef<AbortController | null>(null);
  const autoStarted = useRef(false);

  const applyUpdate = useCallback(
    (nextStatus: string, nextUrl: string | null, message: string | null) => {
      setStatus(nextStatus);
      setVideoUrl(nextUrl);
      setStatusMessage(message);
      onStatusChange?.(nextStatus);
      onVideoUrl?.(nextUrl);
    },
    [onStatusChange, onVideoUrl],
  );

  // Slideshow: cycle stills every 4s while the instant preview is showing.
  useEffect(() => {
    if (status === "done" && videoUrl) return;
    if (stills.length <= 1) return;
    const timer = setInterval(
      () => setSlideIdx((prev) => (prev + 1) % stills.length),
      4000,
    );
    return () => clearInterval(timer);
  }, [status, videoUrl, stills.length]);

  // Keep the slide index valid when the still list changes.
  useEffect(() => {
    setSlideIdx((prev) => (stills.length > 0 ? prev % stills.length : 0));
  }, [stills.length]);

  // Initial status snapshot when a videoId is present but no known state.
  useEffect(() => {
    if (!videoId || initialStatus || initialVideoUrl) return;
    let cancelled = false;
    setChecking(true);
    fetchVideoStatus(videoId)
      .then((snapshot) => {
        if (cancelled) return;
        applyUpdate(snapshot.status, snapshot.videoUrl, snapshot.message);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Stay on the instant preview; the user can press Render/Retry.
        setError(
          err instanceof Error
            ? err.message
            : "Could not check render status. Please retry.",
        );
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [videoId, initialStatus, initialVideoUrl, applyUpdate]);

  // Poll every 3s while queued/rendering; stop on done/failed/unmount.
  useEffect(() => {
    if (!videoId || !ACTIVE_STATUSES.has(status)) return;
    const controller = new AbortController();
    pollController.current = controller;
    pollVideoStatus(videoId, {
      intervalMs: pollIntervalMs,
      signal: controller.signal,
      onUpdate: (update) =>
        applyUpdate(update.status, update.videoUrl, update.message),
    })
      .then((final) => {
        if (final.status === "failed") {
          setError(
            final.message ??
              "Render failed in this tab. Your images are kept — tap Retry.",
          );
        } else {
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(
          err instanceof Error
            ? err.message
            : "Status polling stopped. Please retry.",
        );
      });
    return () => controller.abort();
  }, [videoId, status, pollIntervalMs, applyUpdate]);

  const handleRender = useCallback(async () => {
    if (!videoId) {
      setError("Generate a script first — rendering needs a video to attach to.");
      return;
    }
    pollController.current?.abort();
    setActionBusy(true);
    setError(null);
    setSceneLog(null);
    setProgress(0);
    try {
      // Client-side Canvas + MediaRecorder assembly: explicit wizard scenes
      // win, else the stills-derived fallback (narration burned from `scenes`
      // wizard passes them; Supabase rows otherwise — see lib/api.ts).
      // `images` props are never cleared, so Retry keeps every still.
      const explicit = Array.isArray(scenes)
        ? scenes.filter(
            (scene) =>
              scene &&
              typeof scene.imageUrl === "string" &&
              scene.imageUrl.length > 0,
          )
        : [];
      // Fallback keeps narrations by matching each still back to its scene
      // (old code used narration:"" which guaranteed a text-less video).
      const renderScenes: RenderSceneInput[] =
        explicit.length > 0
          ? explicit.map((s) => ({
              imageUrl: s.imageUrl,
              narration:
                typeof s.narration === "string" ? s.narration : "",
              duration:
                typeof s.duration === "number" ? s.duration : 5,
            }))
          : stills.map((imageUrl, idx) => ({
              imageUrl,
              narration: narrationForStill(scenes, imageUrl, idx),
              duration: 5,
            }));
      const snapshot = await startRender(videoId, {
        aspect,
        scenes: renderScenes,
        onProgress: (value) => setProgress(value),
      });
      setProgress(100);
      applyUpdate(snapshot.status, snapshot.videoUrl, snapshot.message);
      if (snapshot.status === "failed") {
        const message =
          snapshot.message ??
          "Render failed. Your images are kept — tap Retry.";
        setError(message);
        setSceneLog(message);
      }
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Could not start rendering. Please retry.";
      setError(message);
      // Failed renders surface the per-scene log inline; stills stay mounted
      // above, so Retry resumes without regenerating images.
      setSceneLog(message);
    } finally {
      setActionBusy(false);
    }
  }, [videoId, applyUpdate, aspect, scenes, stills]);

  // Optional auto-start (wizard "Render on entering step" flows).
  useEffect(() => {
    if (!autoRender || autoStarted.current || !videoId) return;
    if (status !== "draft") return;
    autoStarted.current = true;
    void handleRender();
  }, [autoRender, videoId, status, handleRender]);

  const handleCancel = useCallback(() => {
    pollController.current?.abort();
    pollController.current = null;
    setActionBusy(false);
    setProgress(null);
    // Return to draft so the user can press Render again; stills stay mounted.
    setStatus((prev) => (ACTIVE_STATUSES.has(prev) ? "draft" : prev));
    setStatusMessage("Render cancelled. Your images are kept — press Render to try again.");
  }, []);

  const showFinalVideo = status === "done" && !!videoUrl;
  const polling = (!!videoId && ACTIVE_STATUSES.has(status)) || actionBusy;
  const showProgress =
    !showFinalVideo && progress !== null && (polling || progress > 0);
  const pct = Math.max(0, Math.min(100, progress ?? 0));
  const cleanTitle = title.trim();

  return (
    <div
      className={horizontal ? "vm-vp horizontal" : "vm-vp vertical"}
      aria-label={`Video preview${cleanTitle ? ` — ${cleanTitle}` : ""}`}
    >
      {cleanTitle && <p className="vm-vp-title">{cleanTitle}</p>}

      <div
        className="vm-vp-frame"
        role={showFinalVideo ? undefined : "img"}
        aria-label={
          showFinalVideo
            ? undefined
            : `Instant animated preview (${horizontal ? "horizontal" : "vertical"})`
        }
      >
        {showFinalVideo ? (
          <video
            key={videoUrl}
            src={videoUrl}
            controls
            playsInline
            preload="metadata"
            aria-label={cleanTitle || "Rendered video preview"}
          />
        ) : checking && stills.length === 0 ? (
          <div className="vm-vp-skeleton" role="status" aria-label="Checking render status" />
        ) : stills.length > 0 ? (
          // Instant feedback: live Canvas preview with the caption burned in
          // (same draw path as the MP4) — cycles through stills every 4s.
          // Editable upstream: narration edits in Script/Images steps flow
          // here via the `scenes` prop and into the final render.
          <SceneCaptionCanvas
            key={`${slideIdx}-${stills[slideIdx]}`}
            imageUrl={stills[slideIdx]}
            narration={narrationForStill(scenes, stills[slideIdx], slideIdx)}
            aspect={aspect}
            sceneIdx={slideIdx}
          />
        ) : (
          <div className="vm-vp-empty" role="status">
            <p>No stills yet — generate images first for an instant preview.</p>
          </div>
        )}

        {!showFinalVideo && (
          <span className="vm-vp-badge" role="status">
            {checking ? "Checking…" : statusLabel(status)}
            {stills.length > 1 && status !== "done"
              ? ` · scene ${Math.min(slideIdx + 1, stills.length)}/${stills.length}`
              : ""}
          </span>
        )}
      </div>

      {statusMessage && !showFinalVideo && (
        <p className="vm-vp-note" role="status">
          {statusMessage}
        </p>
      )}

      {/* Single render progress bar + % + cancel (aria-live). */}
      {showProgress && (
        <div aria-live="polite">
          <div
            className="vm-vp-progress"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Render progress"
          >
            <div className="vm-vp-progress-fill" style={{ width: `${pct}%` }} />
          </div>
          <div className="vm-vp-progress-row">
            <p className="vm-vp-note" role="status">
              Rendering… {pct}% — keep this tab open.
            </p>
            <button
              type="button"
              className="vm-vp-btn"
              onClick={handleCancel}
              aria-label="Cancel render"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {sceneLog && !showFinalVideo && (
        <details className="vm-vp-log">
          <summary>Scene log</summary>
          <pre>{sceneLog}</pre>
        </details>
      )}

      {/* Stage 6.3: shared error surface — 401 links Settings, 429 auto-retries. */}
      <ErrorAlert
        message={error}
        onRetry={() => void handleRender()}
        retryLabel={status === "failed" ? "Retry render" : "Retry"}
        autoRetry={error !== null && isRateLimitedMessage(error)}
      />

      {/* One clear Download when done; re-render stays secondary. */}
      <div className="vm-vp-actions">
        {!showFinalVideo && !polling && (
          <button
            type="button"
            className="vm-vp-btn vm-vp-primary"
            onClick={() => void handleRender()}
            disabled={!videoId || checking}
            aria-label={status === "failed" ? "Retry rendering video" : "Render video"}
          >
            {status === "failed" ? "Retry render" : "Render video"}
          </button>
        )}
        {showFinalVideo && videoUrl && (
          <>
            <a
              className="vm-vp-btn vm-vp-primary vm-vp-link"
              href={videoUrl}
              download="final.mp4"
              aria-label="Download rendered MP4"
            >
              Download MP4
            </a>
            <details className="vm-vp-more">
              <summary>More</summary>
              <div className="vm-vp-more-actions">
                <button
                  type="button"
                  className="vm-vp-btn"
                  onClick={() => void handleRender()}
                  disabled={!videoId || actionBusy}
                  aria-label="Regenerate video"
                  title="Runs a fresh render pass with the logged prompts and seeds"
                >
                  Regenerate
                </button>
              </div>
            </details>
          </>
        )}
      </div>

      <style>{PREVIEW_STYLES}</style>
    </div>
  );
}

const PREVIEW_STYLES = `
.vm-vp { display: grid; gap: 0.75rem; width: 100%; }
.vm-vp-title { color: #D4D4D4; font-weight: 600; margin: 0; overflow-wrap: anywhere; }
.vm-vp-frame { position: relative; width: 100%; background: #000; border: 1px solid #2A2A2A; border-radius: 12px; overflow: hidden; }
.vm-vp.vertical .vm-vp-frame { aspect-ratio: 9 / 16; max-width: 360px; margin: 0 auto; }
.vm-vp.horizontal .vm-vp-frame { aspect-ratio: 16 / 9; }
.vm-vp-frame video { width: 100%; height: 100%; display: block; background: #000; }
.vm-vp-kenburns { width: 100%; height: 100%; object-fit: cover; display: block; animation: kenburns 6s ease-in-out infinite alternate; }
@keyframes kenburns { from { transform: scale(1); } to { transform: scale(1.3); } }
.vm-vp-skeleton { position: absolute; inset: 0; background: linear-gradient(100deg, #111 30%, #1A1A1A 50%, #111 70%); background-size: 200% 100%; animation: vm-vp-shimmer 1.4s linear infinite; }
@keyframes vm-vp-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
.vm-vp-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 1rem; text-align: center; }
.vm-vp-empty p { color: #808080; margin: 0; font-size: 0.95rem; line-height: 1.5; }
.vm-vp-badge { position: absolute; left: 0.6rem; bottom: 0.6rem; font-size: 0.8rem; color: #B8B8B8; background: rgba(0,0,0,0.72); border: 1px solid #2A2A2A; border-radius: 999px; padding: 0.3rem 0.75rem; white-space: nowrap; max-width: calc(100% - 1.2rem); overflow: hidden; text-overflow: ellipsis; }
.vm-vp-note { color: #808080; font-size: 0.9rem; margin: 0; line-height: 1.5; overflow-wrap: anywhere; }
.vm-vp-progress { height: 10px; border-radius: 999px; background: #1A1A1A; border: 1px solid #2A2A2A; overflow: hidden; }
.vm-vp-progress-fill { height: 100%; background: #D4D4D4; border-radius: 999px; transition: width 0.3s ease; }
.vm-vp-progress-row { display: flex; align-items: center; justify-content: space-between; gap: 0.6rem; flex-wrap: wrap; margin-top: 0.4rem; }
.vm-vp-primary { background: #D4D4D4; color: #000; border-color: #D4D4D4; font-weight: 600; }
a.vm-vp-primary:hover, button.vm-vp-primary:hover { background: #fff; color: #000; border-color: #fff; }
.vm-vp-more { border: 1px solid #2A2A2A; border-radius: 8px; }
.vm-vp-more summary { min-height: 44px; display: inline-flex; align-items: center; padding: 0 1rem; cursor: pointer; color: #B8B8B8; }
.vm-vp-more-actions { display: flex; gap: 0.6rem; flex-wrap: wrap; padding: 0 0.6rem 0.6rem; }
.vm-vp-log { border: 1px solid #2A2A2A; background: #111; border-radius: 8px; padding: 0.6rem 0.8rem; }
.vm-vp-log summary { color: #B8B8B8; cursor: pointer; min-height: 44px; display: flex; align-items: center; }
.vm-vp-log pre { color: #808080; font-size: 0.8rem; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; margin: 0.5rem 0 0; }
.vm-vp-error { border: 1px solid #5a2a2a; background: #1a1111; color: #d4a0a0; border-radius: 8px; padding: 0.75rem 1rem; }
.vm-vp-error p { margin: 0; line-height: 1.5; }
.vm-vp-actions { display: flex; gap: 0.6rem; flex-wrap: wrap; }
.vm-vp-btn { background: #1A1A1A; color: #B8B8B8; border: 1px solid #2A2A2A; border-radius: 8px; padding: 0.65rem 1.1rem; min-height: 44px; min-width: 44px; cursor: pointer; font-size: 1rem; text-decoration: none; display: inline-flex; align-items: center; justify-content: center; }
a.vm-vp-btn:hover, button.vm-vp-btn:hover { border-color: #D4D4D4; color: #D4D4D4; }
.vm-vp-btn:disabled { opacity: 0.5; cursor: not-allowed; }
@media (min-width: 640px) { .vm-vp.vertical .vm-vp-frame { max-width: 400px; } }
@media (prefers-reduced-motion: reduce) { .vm-vp-kenburns { animation: none; } .vm-vp-progress-fill { transition: none; } .vm-vp-skeleton { animation: none; } }
`;
