/**
 * Vidiomaker — library-image → scene assignment (Agent 5: Video Pipeline Integrator).
 *
 * A "library-selected image" is `{ url, id }` picked from the image library
 * (another agent owns the picker UI). This module is the single integration
 * point between that picker and the video pipeline:
 *
 *   selected { url, id } → scene.image_url (DB `scenes.image_url`, seed NULL,
 *   logged model_id='library') → preview + Canvas render + download unchanged.
 *
 * Contract with the rest of the pipeline:
 * - Generation skip: `lib/images.ts generateAllSceneImages()` skips every
 *   scene whose `image_url` is non-empty, so a library-assigned scene NEVER
 *   triggers a Cloudflare fetch. Custom `uploads/` pictures keep the same
 *   guarantee and are never overwritten (an override always stores the
 *   previous URL + seed so Revert restores them byte-for-byte).
 * - Render: `lib/render.ts` decodes via fetch → Blob → ImageBitmap (no <img>,
 *   no canvas taint), so library URLs flow through Ken Burns + per-frame
 *   captions + MediaRecorder exactly like generated stills. Narration is
 *   untouched by assignment, so text overlays keep working.
 * - Regenerate-single-scene (script text via `/api/regenerate-scene`, which
 *   resets `image_url` to NULL server-side when DB-backed): the caller must
 *   re-persist the override afterwards — see `LIBRARY_MODEL_ID` log helper
 *   + page.tsx `handleRegenerate` (keeps `imageUrls[idx]` + seed NULL).
 *
 * All helpers are pure (no Supabase/network) except `preloadLibraryImage`,
 * which is CORS-aware — see its docs.
 */

/** A library picker selection: renderable URL + library row id. */
export interface LibraryImageSelection {
  url: string;
  id: string;
}

/**
 * Per-scene override state. `prevUrl`/`prevSeed` are the generated (or
 * uploaded) values the scene had BEFORE assignment, so Revert restores the
 * exact previous still. `prevUrl` is null when the scene had no image yet.
 */
export interface LibrarySceneOverride extends LibraryImageSelection {
  prevUrl: string | null;
  prevSeed: number | string | null;
}

/** Logged model id for library-sourced stills (seed is logged as NULL). */
export const LIBRARY_MODEL_ID = "library";

/** True when the value is a usable library selection (non-empty url + id). */
export function isLibrarySelection(
  value: unknown,
): value is LibraryImageSelection {
  if (value === null || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.url === "string" &&
    row.url.trim().length > 0 &&
    typeof row.id === "string" &&
    row.id.trim().length > 0
  );
}

/** True when a seed value means "library-sourced" (NULL in `scenes.seed`). */
export function isLibrarySeed(seed: unknown): boolean {
  return seed === null || seed === undefined;
}

/**
 * Build the next `imageUrls` map + overrides map for assigning a library
 * image to scene `idx`. Pure — the caller applies the maps to state and
 * persists via `persistSceneImage(videoId, idx, url, null)`. Never throws.
 * The previous URL/seed are stashed so Revert is lossless (uploads-safe).
 */
export function assignLibraryImage(
  imageUrls: Record<number, string>,
  overrides: Record<number, LibrarySceneOverride>,
  scenes: Array<{ idx: number; seed: number | string | null }>,
  idx: number,
  selection: LibraryImageSelection,
): {
  imageUrls: Record<number, string>;
  overrides: Record<number, LibrarySceneOverride>;
} {
  const url = selection.url.trim();
  const id = selection.id.trim();
  if (url.length === 0 || id.length === 0) return { imageUrls, overrides };
  const existing = overrides[idx];
  const prevUrl =
    existing !== undefined
      ? existing.prevUrl // Keep the ORIGINAL pre-library values across re-assigns.
      : (imageUrls[idx] ?? null);
  const prevSeed =
    existing !== undefined
      ? existing.prevSeed
      : (scenes.find((s) => s.idx === idx)?.seed ?? null);
  return {
    imageUrls: { ...imageUrls, [idx]: url },
    overrides: { ...overrides, [idx]: { url, id, prevUrl, prevSeed } },
  };
}

/**
 * Build the next maps for reverting scene `idx` to its pre-library still.
 * Pure — the caller persists the restored URL + seed. When the scene had no
 * image before assignment, the key is removed (back to "no still"). Never
 * throws; unknown idx is a no-op returning the inputs unchanged.
 */
export function revertLibraryImage(
  imageUrls: Record<number, string>,
  overrides: Record<number, LibrarySceneOverride>,
  idx: number,
): {
  imageUrls: Record<number, string>;
  overrides: Record<number, LibrarySceneOverride>;
  restoredUrl: string | null;
  restoredSeed: number | string | null;
} {
  const existing = overrides[idx];
  if (!existing) {
    return { imageUrls, overrides, restoredUrl: null, restoredSeed: null };
  }
  const nextOverrides = { ...overrides };
  delete nextOverrides[idx];
  const nextUrls = { ...imageUrls };
  if (existing.prevUrl !== null) nextUrls[idx] = existing.prevUrl;
  else delete nextUrls[idx];
  return {
    imageUrls: nextUrls,
    overrides: nextOverrides,
    restoredUrl: existing.prevUrl,
    restoredSeed: existing.prevSeed,
  };
}

/**
 * Ops log line for a library assignment (mirrors the backend "Images
 * generated" log shape: prompts/seeds/urls per scene, no secrets).
 */
export function logLibraryAssign(idx: number, selection: LibraryImageSelection): void {
  // eslint-disable-next-line no-console
  console.info("[images] library assign.", {
    idx,
    model_id: LIBRARY_MODEL_ID,
    seed: null,
    library_id: selection.id,
    image_url: selection.url,
  });
}

/**
 * Friendly error when a library URL cannot be loaded (broken URL, host down,
 * or CORS-blocked fetch). Points at re-attaching, never at regenerating.
 */
export function libraryLoadErrorMessage(sceneNo: number, count: number): string {
  return (
    `Render failed on scene ${sceneNo}/${count}: the library image could ` +
    "not be downloaded (broken URL or the host blocks cross-origin reads). " +
    "Re-attach a valid library image (or Revert to the generated still), " +
    "then retry — other scenes are kept."
  );
}

/* ------------------------- CORS-aware preload ------------------------- */

/**
 * In-memory preload results: url → true (loads) / false (broken). Keeps the
 * Images step from re-probing the same library URL on every render, and lets
 * Replace buttons disable fast for dead URLs. Session-only (no persistence).
 */
const PRELOAD_CACHE = new Map<string, boolean>();

/** Clear the preload cache (tests / library refresh). */
export function clearLibraryPreloadCache(): void {
  PRELOAD_CACHE.clear();
}

/**
 * Probe whether a library URL will load in this browser. Uses fetch (same
 * mechanism `render.ts loadSceneBitmap` uses: CORS fetch → Blob), so a
 * `true` here means the Canvas render path can decode it too. Results are
 * cached per URL. Never throws — false means "broken or CORS-blocked".
 *
 * NOTE: a `false` result does NOT mean the preview fails: `SceneCaptionCanvas`
 * falls back to a no-CORS `<img>` (tainted but displayable — preview never
 * reads pixels back), so library hosts without CORS headers still preview
 * fine; only the MP4 render needs the CORS-readable bytes.
 */
export async function preloadLibraryImage(url: string): Promise<boolean> {
  const clean = (url ?? "").trim();
  if (clean.length === 0) return false;
  if (clean.startsWith("blob:") || clean.startsWith("data:")) return true;
  const cached = PRELOAD_CACHE.get(clean);
  if (cached !== undefined) return cached;
  try {
    const response = await fetch(clean, { method: "GET", mode: "cors" });
    if (!response.ok) {
      PRELOAD_CACHE.set(clean, false);
      return false;
    }
    const blob = await response.blob();
    const ok = blob.size > 0;
    PRELOAD_CACHE.set(clean, ok);
    return ok;
  } catch {
    PRELOAD_CACHE.set(clean, false);
    return false;
  }
}
