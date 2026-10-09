/**
 * Vidiomaker — pure-frontend scene image orchestration (Cloudflare Workers AI).
 *
 * Replaces POST /api/generate-images (old Laravel ImageController,
 * eliminated for Vercel deploy). Flow per scene:
 *
 *   1. Skip when `image_url` is already set — custom uploads (paths/URLs
 *      containing `uploads/`) are NEVER overwritten, and previously
 *      generated stills are kept so a Retry after a network kill resumes
 *      the missing scenes only.
 *   2. Otherwise POST the still to our same-origin proxy
 *      `/api/generate-image`, which calls Cloudflare Workers AI
 *      (`{ACCOUNT_ID}/ai/run/{model}` — credentials stay server-side in
 *      CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN) via lib/cloudflare
 *      (retries 2s→4s→8s, 60s timeout, selectable FLUX model).
 *      Same seed+prompt+model reproduces the same image server-side.
 *   3. Upload the bytes to Supabase Storage `uploads/` bucket
 *      (`{videoId}/scene-{idx}.jpg`, upsert) and persist the resulting
 *      public/signed URL to `scenes.image_url` (+ `seed`).
 *
 * Supabase persistence is best-effort: anonymous visitors have no storage /
 * scenes write policy (see supabase/storage.md + schema.sql — `authenticated`
 * only), so when upload/update is rejected an in-memory object URL is used
 * instead so the UI keeps working for this session. (Unlike the old GET-URL
 * provider there is no deterministic public URL fallback — Cloudflare
 * images only exist as bytes until uploaded.)
 *
 * Theme/errors: friendly strings only (never bare 500) via lib/errors.ts.
 */

import { cloudflareSceneMessage } from "./errors";
import {
  CLOUDFLARE_DEFAULT_MODEL,
  CLOUDFLARE_DEFAULT_STEPS,
  fetchSceneImageBlob,
  normalizeImageModel,
  normalizeImageSteps,
} from "./cloudflare";
import { isSupabaseConfigured, supabase } from "./supabase";

/** Storage bucket for scene stills (see supabase/storage.md). */
export const SCENE_IMAGE_BUCKET = "uploads";

/** Signed-URL lifetime for private-bucket stills (1 year). */
const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 365;

/** One scene row as read from the Supabase `scenes` table. */
export interface SceneImageInput {
  idx: number;
  imagePrompt: string;
  seed: number;
  image_url?: string | null;
}

/** One generated still (mirrors the old backend `images[]` shape). */
export interface SceneImageResult {
  idx: number;
  image_url: string;
  seed: number;
}

export interface GenerateAllSceneImagesResult {
  images: SceneImageResult[];
  /** Idx values that failed this pass — Retry resumes these only. */
  failed: number[];
}

export interface GenerateAllSceneImagesOptions {
  /** Supabase video id — enables Storage upload + scenes.image_url update. */
  videoId?: string;
  /** Width in px (default 1080 = vertical 1080x1920). */
  w?: number;
  /** Height in px (default 1920). */
  h?: number;
  /** Cloudflare Workers AI image model (one of the 4 FLUX ids). */
  model?: string;
  /** Diffusion steps 1–8 (Settings → Images, default 4). */
  steps?: number;
  /** Per-scene progress callback (called after each scene settles). */
  onProgress?: (done: number, total: number) => void;
}

export interface RegenerateSceneImageOptions {
  videoId?: string;
  w?: number;
  h?: number;
  model?: string;
  /** Diffusion steps 1–8 (Settings → Images, default 4). */
  steps?: number;
  /** 0-based scene idx used for the Storage filename (`scene-{idx}.jpg`). */
  storageIdx?: number;
  /** 1-based position for friendly errors, e.g. "retrying scene 2/5...". */
  sceneIdx?: number;
  sceneTotal?: number;
}

/** True when the row is a user-uploaded picture (never overwritten). */
export function isCustomUploadUrl(imageUrl: string | null | undefined): boolean {
  return typeof imageUrl === "string" && imageUrl.includes("uploads/");
}

/**
 * True when a scene already has a usable still and Cloudflare generation
 * MUST be skipped for it. Covers all three sources (Agent 5 contract):
 * custom `uploads/` pictures, previously generated stills, AND library-
 * assigned images (`lib/libraryImages.ts` — any non-empty URL, including
 * external hosts). Resume-safe: Retry passes resume only the missing scenes.
 */
export function hasSceneImage(imageUrl: string | null | undefined): boolean {
  return typeof imageUrl === "string" && imageUrl.trim().length > 0;
}

/** Fresh random seed for image regen (mirrors backend random_int range). */
export function randomImageSeed(): number {
  return Math.floor(1 + Math.random() * 999999);
}

function extForBlob(blob: Blob): string {
  return blob.type === "image/png" ? "png" : "jpg";
}

function contentTypeForBlob(blob: Blob): string {
  if (blob.type === "image/png" || blob.type === "image/jpeg") return blob.type;
  return "image/jpeg";
}

/**
 * Upload raw image bytes to the `uploads/` bucket at `path`
 * (e.g. `{videoId}/scene-0.jpg`, upsert) and return a renderable URL.
 * Prefers a long-lived signed URL (bucket is private per storage.md),
 * falls back to the public URL when signing is unavailable.
 */
export async function uploadBlobToSupabase(
  blob: Blob,
  path: string
): Promise<string> {
  if (!isSupabaseConfigured()) {
    throw new Error(
      "Supabase is not configured. Add NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY, then retry."
    );
  }
  const cleanPath = path.replace(/^uploads\//, "").replace(/^\/+/, "");
  if (cleanPath.length === 0) {
    throw new Error("Cannot upload the scene image: empty storage path.");
  }

  const { error: uploadError } = await supabase.storage
    .from(SCENE_IMAGE_BUCKET)
    .upload(cleanPath, blob, {
      contentType: contentTypeForBlob(blob),
      upsert: true,
    });
  if (uploadError) {
    throw new Error(
      `Could not save the scene image (${uploadError.message}). Check your connection, then retry.`
    );
  }

  // Private bucket → signed URL first; public-bucket setups use getPublicUrl.
  try {
    const { data, error } = await supabase.storage
      .from(SCENE_IMAGE_BUCKET)
      .createSignedUrl(cleanPath, SIGNED_URL_TTL_SECONDS);
    if (!error && data?.signedUrl) return data.signedUrl;
  } catch {
    // Fall through to the public URL.
  }
  const { data } = supabase.storage
    .from(SCENE_IMAGE_BUCKET)
    .getPublicUrl(cleanPath);
  if (!data?.publicUrl) {
    throw new Error(
      "Saved the scene image but could not resolve its URL. Please retry."
    );
  }
  return data.publicUrl;
}

/**
 * Best-effort `scenes.image_url` (+ `seed`) update. Returns true when the
 * row was persisted, false when RLS/network rejected it (anonymous visitors
 * have select-only access — the caller keeps the in-memory preview URL so
 * the UI still works for this session). Never throws.
 *
 * `seed` accepts NULL for library-assigned stills (Agent 5 contract:
 * `scenes.seed` is nullable — library images have no diffusion seed, logged
 * model_id='library'). Generated stills always pass a finite number.
 */
export async function persistSceneImage(
  videoId: string,
  idx: number,
  imageUrl: string,
  seed: number | null
): Promise<boolean> {
  if (!isSupabaseConfigured()) return false;
  try {
    const { error } = await supabase
      .from("scenes")
      .update({ image_url: imageUrl, seed })
      .eq("video_id", videoId)
      .eq("idx", idx);
    if (error) {
      // eslint-disable-next-line no-console
      console.warn(
        `[images] scenes.image_url update skipped (idx=${idx}): ${error.message}`
      );
      return false;
    }
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[images] scenes.image_url update skipped (idx=${idx}): ${err instanceof Error ? err.message : "network error"}`
    );
    return false;
  }
}

function storagePathFor(videoId: string, idx: number, blob: Blob): string {
  return `${videoId}/scene-${idx}.${extForBlob(blob)}`;
}

/**
 * Fetch + persist ONE missing scene still. Returns the result entry, or
 * null when Cloudflare failed (caller records idx in `failed[]`).
 * Never throws — per-scene isolation so one bad scene never aborts the rest.
 */
async function generateOneSceneImage(
  scene: SceneImageInput,
  opts: {
    videoId?: string;
    w: number;
    h: number;
    model: string;
    steps: number;
    scenePosition: number;
    sceneTotal: number;
  }
): Promise<SceneImageResult | null> {
  const { videoId, w, h, model, steps, scenePosition, sceneTotal } = opts;
  // eslint-disable-next-line no-console
  console.info(
    `[images] scene ${scenePosition}/${sceneTotal} idx=${scene.idx} seed=${Math.floor(scene.seed)} steps=${steps}`
  );
  let blob: Blob;
  try {
    blob = await fetchSceneImageBlob(scene.imagePrompt, scene.seed, {
      w,
      h,
      model,
      steps,
      sceneIdx: scenePosition,
      sceneTotal,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[images] scene ${scenePosition}/${sceneTotal} failed: ${err instanceof Error ? err.message : "unknown error"}`
    );
    return null;
  }

  // No deterministic public URL exists for Cloudflare (bytes only) —
  // use an in-memory object URL when Storage upload / DB update is
  // unavailable (e.g. anonymous visitor). It lasts for this tab session.
  let imageUrl = URL.createObjectURL(blob);
  if (videoId) {
    try {
      imageUrl = await uploadBlobToSupabase(
        blob,
        storagePathFor(videoId, scene.idx, blob)
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[images] storage upload skipped (idx=${scene.idx}): ${err instanceof Error ? err.message : "unknown error"}`
      );
      // Keep the object URL so the card still previews this session.
    }
    await persistSceneImage(videoId, scene.idx, imageUrl, scene.seed);
  }
  return { idx: scene.idx, image_url: imageUrl, seed: scene.seed };
}

/**
 * Fetch stills for all scenes missing an image (pure frontend).
 * Scenes with any existing `image_url` — custom `uploads/` pictures or
 * previously generated stills — are returned as-is (never re-fetched).
 * Sequential per-scene attempts (gentle on the Cloudflare quota);
 * one scene's failure never aborts the rest. Returns `{images, failed[]}`
 * ordered by idx; `failed` is empty on total success.
 */
export async function generateAllSceneImages(
  scenes: SceneImageInput[],
  options: GenerateAllSceneImagesOptions = {}
): Promise<GenerateAllSceneImagesResult> {
  const w = options.w ?? 1080;
  const h = options.h ?? 1920;
  const model = normalizeImageModel(
    options.model ?? CLOUDFLARE_DEFAULT_MODEL
  );
  const steps =
    options.steps === undefined
      ? CLOUDFLARE_DEFAULT_STEPS
      : normalizeImageSteps(options.steps);
  const ordered = [...scenes].sort((a, b) => a.idx - b.idx);
  const total = ordered.length;

  const images: SceneImageResult[] = [];
  const failed: number[] = [];

  let done = 0;
  for (const scene of ordered) {
    const existing = (scene.image_url ?? "").trim();
    if (hasSceneImage(existing)) {
      // Custom-upload skip + resume-safe + library-assign skip: keep the
      // stored still untouched (never re-fetched, never overwritten).
      images.push({ idx: scene.idx, image_url: existing, seed: scene.seed });
      done += 1;
      options.onProgress?.(done, total);
      continue;
    }
    if (scene.imagePrompt.trim().length === 0) {
      failed.push(scene.idx);
      done += 1;
      options.onProgress?.(done, total);
      continue;
    }
    const result = await generateOneSceneImage(scene, {
      videoId: options.videoId,
      w,
      h,
      model,
      steps,
      scenePosition: done + 1,
      sceneTotal: total,
    });
    if (result) images.push(result);
    else failed.push(scene.idx);
    done += 1;
    options.onProgress?.(done, total);
  }

  images.sort((a, b) => a.idx - b.idx);
  failed.sort((a, b) => a - b);

  // Per-video log (mirrors backend "Images generated." log: prompts/seeds/
  // urls per scene, no secrets). Failed positions use 1-based X/Y order.
  // eslint-disable-next-line no-console
  console.info("[images] generation pass finished.", {
    total,
    succeeded: images.length,
    failed,
  });

  return { images, failed };
}

/**
 * Regenerate ONE scene's image with a fresh seed. Fetches the new still,
 * uploads it to Storage when `videoId` is given (best-effort), and returns
 * the new `{imageUrl, seed}` — persisting to `scenes` is the caller's job
 * via persistSceneImage() (or api.regenerateScene, which does both).
 */
export async function regenerateSceneImage(
  prompt: string,
  newSeed: number = randomImageSeed(),
  options: RegenerateSceneImageOptions = {}
): Promise<{ imageUrl: string; seed: number }> {
  const w = options.w ?? 1080;
  const h = options.h ?? 1920;
  const model = normalizeImageModel(options.model ?? CLOUDFLARE_DEFAULT_MODEL);
  const steps =
    options.steps === undefined
      ? CLOUDFLARE_DEFAULT_STEPS
      : normalizeImageSteps(options.steps);
  const seed = Math.floor(newSeed);

  const blob = await fetchSceneImageBlob(prompt, seed, {
    w,
    h,
    model,
    steps,
    sceneIdx: options.sceneIdx,
    sceneTotal: options.sceneTotal,
  });

  let imageUrl = URL.createObjectURL(blob);
  if (options.videoId) {
    try {
      imageUrl = await uploadBlobToSupabase(
        blob,
        storagePathFor(options.videoId, options.storageIdx ?? 0, blob)
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[images] regen storage upload skipped: ${err instanceof Error ? err.message : "unknown error"}`
      );
    }
  }
  return { imageUrl, seed };
}

/** Friendly "X/Y failed, tap Retry" message (mirrors old backend 502 text). */
export function busyRetryMessage(failed: number[], total: number): string {
  if (failed.length === 0) return cloudflareSceneMessage(false);
  return cloudflareSceneMessage(false, failed[0] + 1, total);
}

/**
 * Agent 2 — single-image remake with an explicit (possibly AI-rewritten) prompt.
 *
 * Thin DRY wrapper over `regenerateSceneImage()` (same fetch → Storage-upload
 * path, same return shape). Persisting to `scenes` is the caller's job via
 * `persistSceneImage()` — mirroring `regenerateSceneImage` so the page keeps
 * its merge-only-idx pattern (`setImageUrls` / `setScenes` / `setImageStatuses`
 * per idx, never a full-map reset).
 *
 * Uploads/library safety: this helper never decides what to overwrite — the
 * caller does. Convention (same as `handleImageRetry` / `handleImageRegen` in
 * `app/page.tsx`): when the user explicitly remakes a library-assigned scene
 * (seed NULL, `libraryOverrides[idx]` set), the caller clears
 * `libraryOverrides[idx]` on success — the explicit AI still replaces the
 * library picture and Revert no longer applies. Custom `uploads/` pictures are
 * only replaced when the user explicitly presses Remake on that card; the
 * bulk pass (`generateAllSceneImages`) still skips every non-empty URL via
 * `hasSceneImage()`, so frozen scenes never refetch.
 */
export async function remakeSceneImageWithPrompt(
  newPrompt: string,
  opts: RegenerateSceneImageOptions & { seed: number }
): Promise<{ imageUrl: string; seed: number }> {
  const { seed: rawSeed, ...rest } = opts;
  const seed = Math.floor(rawSeed);
  const model = normalizeImageModel(rest.model ?? CLOUDFLARE_DEFAULT_MODEL);
  // eslint-disable-next-line no-console
  console.info(
    `[images] single remake idx=${rest.storageIdx ?? "?"} seed=${seed} model=${model}`
  );
  return regenerateSceneImage(newPrompt, seed, rest);
}

/**
 * Agent 2 — params-object variant of the single-image remake. Resolves the
 * seed from `seedMode` (`"new"` = fresh `randomImageSeed()`, `"same"` = reuse
 * `existingSeed` when finite, else a fresh seed) then delegates to
 * `remakeSceneImageWithPrompt()` (which delegates to `regenerateSceneImage()`).
 * `currentPrompt` is accepted for logging / future diffing only — `newPrompt`
 * is what gets rendered. Never loops scenes; other idx values are untouched.
 */
export interface RemakeSingleSceneImageParams {
  currentPrompt: string;
  newPrompt: string;
  seedMode: "new" | "same";
  existingSeed: number | null;
  videoId?: string;
  w?: number;
  h?: number;
  model?: string;
  steps?: number;
  storageIdx?: number;
  sceneIdx?: number;
  sceneTotal?: number;
}

export async function remakeSingleSceneImage(
  params: RemakeSingleSceneImageParams
): Promise<{ imageUrl: string; seed: number }> {
  const {
    newPrompt,
    seedMode,
    existingSeed,
    videoId,
    w,
    h,
    model,
    steps,
    storageIdx,
    sceneIdx,
    sceneTotal,
  } = params;
  const seed =
    seedMode === "same" && typeof existingSeed === "number" && Number.isFinite(existingSeed)
      ? Math.floor(existingSeed)
      : randomImageSeed();
  return remakeSceneImageWithPrompt(newPrompt, {
    seed,
    videoId,
    w,
    h,
    model,
    steps,
    storageIdx,
    sceneIdx,
    sceneTotal,
  });
}
