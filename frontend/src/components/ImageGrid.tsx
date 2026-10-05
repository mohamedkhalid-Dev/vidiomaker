"use client";

/**
 * Vidiomaker — Images step grid (Cloudflare Workers AI results).
 *
 * Props contract (mount inside the wizard Images step without restructuring it):
 * ```tsx
 * import ImageGrid from "@/components/ImageGrid";
 *
 * <div id="images-step">
 *   <ImageGrid
 *     scenes={scenes}          // { idx, imagePrompt, seed, imageUrl?, status? }[]
 *     aspect="1080x1920"       // or "1920x1080"
 *     onRegen={(idx) => regenSceneImage(idx)}  // parent assigns a new random seed + refetches
 *     onRetry={(idx) => retrySceneImage(idx)}  // parent refetches same seed+prompt
 *   />
 * </div>
 * ```
 *
 * Notes:
 * - Prompt text renders as plain text (React escapes by default; never
 *   dangerouslySetInnerHTML with user text).
 * - Seed is shown per card (badge) and should already be logged server-side
 *   so the same seed+prompt reproduces the same image.
 * - `onRegen(idx)` = requests a NEW random seed; `onRetry(idx)` = same seed retry.
 * - Black/grey theme via CSS vars from globals.css; self-contained <style> so
 *   no wizard/global CSS changes are needed.
 */

import SceneCaptionCanvas from "./SceneCaptionCanvas";
import type { LibraryImageSelection } from "../lib/libraryImages";

export type SceneStatus = "pending" | "loading" | "ready" | "failed";

export interface ImageGridScene {
  idx: number;
  imagePrompt: string;
  /** NULL = library-sourced still (seed N/A, logged model_id='library'). */
  seed: number | null;
  imageUrl?: string;
  status?: SceneStatus;
  /** Editable caption burned onto the canvas + final MP4. */
  narration?: string;
}

export type ImageAspect = "1080x1920" | "1920x1080";

export interface ImageGridProps {
  scenes: ImageGridScene[];
  aspect?: ImageAspect;
  onRegen: (idx: number) => void;
  onRetry: (idx: number) => void;
  /** Called when the user edits a scene caption — parent must persist it. */
  onNarrationChange?: (idx: number, narration: string) => void;
  /**
   * Agent 5 — library integration. The currently selected library image
   * (`{ url, id }` from the picker). When set, each card gets a "Replace
   * with library image" button calling `onLibraryAssign(idx)`; scenes
   * present in `libraryOverrides` show a "library" badge + "Revert to
   * generated" button calling `onLibraryRevert(idx)` instead.
   */
  libraryImage?: LibraryImageSelection | null;
  /** idx → active override (scene currently shows a library still). */
  libraryOverrides?: Record<number, { id: string }>;
  /** Assign the selected library image to scene `idx` (parent persists). */
  onLibraryAssign?: (idx: number) => void;
  /** Restore scene `idx` to its pre-library still (parent persists). */
  onLibraryRevert?: (idx: number) => void;
}

function isFailed(scene: ImageGridScene): boolean {
  return scene.status === "failed" || (!scene.imageUrl && scene.status !== "loading" && scene.status !== "pending");
}

function isLoading(scene: ImageGridScene): boolean {
  return scene.status === "loading" || scene.status === "pending" || (!scene.imageUrl && !isFailed(scene));
}

export default function ImageGrid({
  scenes,
  aspect = "1080x1920",
  onRegen,
  onRetry,
  onNarrationChange,
  libraryImage = null,
  libraryOverrides = {},
  onLibraryAssign,
  onLibraryRevert,
}: ImageGridProps) {
  const horizontal = aspect === "1920x1080";

  if (!Array.isArray(scenes) || scenes.length === 0) {
    return (
      <div className="vm-imagegrid-empty" role="status">
        <p>No scenes yet. Generate a script first, then come back to render images.</p>
        <style>{EMPTY_STYLES}</style>
      </div>
    );
  }

  return (
    <div
      id="images-step-grid"
      className={horizontal ? "vm-imagegrid horizontal" : "vm-imagegrid vertical"}
      role="list"
      aria-label={`Scene images (${horizontal ? "horizontal 1920 by 1080" : "vertical 1080 by 1920"})`}
    >
      {scenes.map((scene) => {
        const failed = isFailed(scene);
        const loading = !failed && isLoading(scene);
        const libraryActive = libraryOverrides[scene.idx] !== undefined;
        const canAssignLibrary =
          typeof onLibraryAssign === "function" &&
          libraryImage !== null &&
          libraryImage.url.trim().length > 0 &&
          !libraryActive;
        const canRevertLibrary =
          libraryActive && typeof onLibraryRevert === "function";
        return (
          <article key={scene.idx} className="vm-scene-card" role="listitem" aria-label={`Scene ${scene.idx + 1}`}>
            <div className="vm-scene-media">
              {loading ? (
                <div className="vm-shimmer" aria-label={`Loading scene ${scene.idx + 1} image`} role="status" />
              ) : failed || !scene.imageUrl ? (
                <div className="vm-failed" role="alert">
                  <p>Couldn&apos;t load scene {scene.idx + 1}. Cloudflare may be busy.</p>
                  <button
                    type="button"
                    className="vm-btn"
                    onClick={() => onRetry(scene.idx)}
                    aria-label={`Retry scene ${scene.idx + 1} image`}
                  >
                    Retry
                  </button>
                </div>
              ) : (
                <SceneCaptionCanvas
                  imageUrl={scene.imageUrl}
                  narration={scene.narration ?? ""}
                  aspect={aspect}
                  sceneIdx={scene.idx}
                  onNarrationChange={
                    onNarrationChange
                      ? (next) => onNarrationChange(scene.idx, next)
                      : undefined
                  }
                />
              )}
              {libraryActive && !loading ? (
                <span className="vm-library-badge" title="Library image — AI generation skipped for this scene">
                  library
                </span>
              ) : null}
            </div>

            <div className="vm-scene-body">
              <div className="vm-scene-meta">
                <span className="vm-scene-title">Scene {scene.idx + 1}</span>
                {libraryActive ? (
                  <span className="vm-seed-badge" title="Library image — no diffusion seed (logged seed=NULL, model_id='library')">
                    seed:library
                  </span>
                ) : (
                  <span className="vm-seed-badge" title={`Seed ${scene.seed} — same seed+prompt reproduces this image`}>
                    seed:{scene.seed}
                  </span>
                )}
              </div>

              {/* Plain-text render: React escapes this, safe against XSS. */}
              <p className="vm-prompt">{scene.imagePrompt}</p>

              <div className="vm-actions">
                <button
                  type="button"
                  className="vm-btn"
                  onClick={() => onRegen(scene.idx)}
                  disabled={loading}
                  aria-label={`Regenerate scene ${scene.idx + 1} with a new seed`}
                  title="Requests a new random seed for this scene"
                >
                  Regen image
                </button>
                {failed ? (
                  <button
                    type="button"
                    className="vm-btn"
                    onClick={() => onRetry(scene.idx)}
                    aria-label={`Retry scene ${scene.idx + 1} image`}
                  >
                    Retry
                  </button>
                ) : null}
                {canAssignLibrary ? (
                  <button
                    type="button"
                    className="vm-btn"
                    onClick={() => onLibraryAssign?.(scene.idx)}
                    disabled={loading}
                    aria-label={`Replace scene ${scene.idx + 1} with the selected library image`}
                    title="Uses the selected library image for this scene — AI generation is skipped"
                  >
                    Replace with library image
                  </button>
                ) : null}
                {canRevertLibrary ? (
                  <button
                    type="button"
                    className="vm-btn"
                    onClick={() => onLibraryRevert?.(scene.idx)}
                    disabled={loading}
                    aria-label={`Revert scene ${scene.idx + 1} to the generated image`}
                    title="Restores the image this scene had before the library replacement"
                  >
                    Revert to generated
                  </button>
                ) : null}
              </div>
            </div>
          </article>
        );
      })}
      <style>{GRID_STYLES}</style>
    </div>
  );
}

const EMPTY_STYLES = `
.vm-imagegrid-empty { background: #111; border: 1px solid #2A2A2A; border-radius: 12px; padding: 1rem; color: #B8B8B8; }
`;

const GRID_STYLES = `
.vm-imagegrid { display: grid; gap: 1rem; grid-template-columns: 1fr; }
@media (min-width: 640px) { .vm-imagegrid.vertical { grid-template-columns: repeat(2, 1fr); } }
@media (min-width: 1024px) { .vm-imagegrid.vertical { grid-template-columns: repeat(3, 1fr); } }
@media (min-width: 640px) { .vm-imagegrid.horizontal { grid-template-columns: repeat(2, 1fr); } }
.vm-scene-card { background: #111; border: 1px solid #2A2A2A; border-radius: 12px; overflow: hidden; display: flex; flex-direction: column; }
.vm-scene-media { background: #000; position: relative; overflow: hidden; }
.vm-imagegrid.vertical .vm-scene-media { aspect-ratio: 9 / 16; }
.vm-imagegrid.horizontal .vm-scene-media { aspect-ratio: 16 / 9; }
.vm-scene-media img { width: 100%; height: 100%; object-fit: cover; display: block; }
.vm-shimmer { position: absolute; inset: 0; background: linear-gradient(100deg, #111 30%, #1A1A1A 50%, #111 70%); background-size: 200% 100%; animation: vm-shimmer 1.4s linear infinite; }
@keyframes vm-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
.vm-failed { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.75rem; padding: 1rem; text-align: center; color: #B8B8B8; }
.vm-failed p { color: #9E9E9E; margin: 0; font-size: 0.95rem; }
.vm-scene-body { padding: 0.9rem; display: flex; flex-direction: column; gap: 0.6rem; }
.vm-scene-meta { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
.vm-scene-title { color: #D4D4D4; font-weight: 600; }
.vm-seed-badge { font-size: 0.8rem; color: #9E9E9E; border: 1px solid #2A2A2A; background: #1A1A1A; border-radius: 999px; padding: 0.2rem 0.65rem; white-space: nowrap; font-variant-numeric: tabular-nums; }
.vm-library-badge { position: absolute; top: 0.6rem; right: 0.6rem; font-size: 0.75rem; font-weight: 600; color: #000; background: #D4D4D4; border-radius: 999px; padding: 0.25rem 0.7rem; white-space: nowrap; }
.vm-prompt { color: #B8B8B8; font-size: 0.9rem; line-height: 1.45; margin: 0; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.vm-actions { display: flex; gap: 0.6rem; flex-wrap: wrap; }
.vm-btn { background: #1A1A1A; color: #B8B8B8; border: 1px solid #2A2A2A; border-radius: 8px; padding: 0.65rem 1.1rem; min-height: 44px; min-width: 44px; cursor: pointer; font-size: 1rem; }
.vm-btn:hover { border-color: #D4D4D4; color: #D4D4D4; }
.vm-btn:disabled { opacity: 0.5; cursor: not-allowed; }
`;
