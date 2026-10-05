/**
 * Frontend API client (Vercel-native).
 * Full calls (models, generate-script, render, polling) land in Stages 2–5.
 * Deploy (frontend-only, Vercel): all requests go to same-origin Next.js
 * Route Handlers (relative /api/*).
 * Stage 6.3: user-facing strings funnel through lib/errors.ts.
 */

import {
  networkErrorMessage,
  statusToUserMessage,
  toUserMessage,
} from "./errors";
import { renderVideoClient, type RenderAspect, type RenderSceneInput } from "./render";
import { isSupabaseConfigured, supabase } from "./supabase";
import {
  generateAllSceneImages,
  persistSceneImage,
  randomImageSeed,
  regenerateSceneImage,
  type SceneImageInput,
} from "./images";
import { CLOUDFLARE_DEFAULT_MODEL, CLOUDFLARE_DEFAULT_STEPS, normalizeImageSteps } from "./cloudflare";

// Deploy (frontend-only, Vercel): same-origin Next.js Route Handlers.
// This constant stays "" so buildUrl() yields relative /api/* paths.
const API_BASE_URL = "";

function buildUrl(path: string): string {
  return `${API_BASE_URL}${path}`;
}

async function parseJsonResponse(response: Response) {
  // Surface the backend's friendly `message` (422/404/502) instead of a bare
  // status code, so the UI can show e.g. "Cloudflare busy, retrying scene…".
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const raw =
      data && typeof data.message === "string" && data.message.length > 0
        ? data.message
        : "";
    // 401 → Settings link hint, 429 → countdown hint (ErrorAlert renders both).
    const detail =
      raw ||
      (response.status === 401
        ? "Invalid API key (401). Update your key in Settings (/settings) and try again."
        : "");
    throw new Error(statusToUserMessage(response.status, detail));
  }
  return data;
}

export async function checkHealth(): Promise<{ ok: boolean }> {
  const response = await fetch(buildUrl("/api/health"));
  return parseJsonResponse(response);
}

export async function fetchModels(): Promise<unknown> {
  const response = await fetch(buildUrl("/api/models"));
  return parseJsonResponse(response);
}

export async function generateScript(payload: {
  topic: string;
  model: string;
}): Promise<unknown> {
  const response = await fetch(buildUrl("/api/generate-script"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  return parseJsonResponse(response);
}

export async function renderVideo(videoId: string): Promise<unknown> {
  const response = await fetch(buildUrl("/api/render"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ video_id: videoId })
  });
  return parseJsonResponse(response);
}

export async function getVideoStatus(videoId: string): Promise<unknown> {
  const response = await fetch(buildUrl(`/api/videos/${videoId}/status`));
  return parseJsonResponse(response);
}

export interface SceneImage {
  idx: number;
  image_url: string;
  seed: number;
}

export interface GenerateImagesResult {
  video_id: string;
  images: SceneImage[];
  /** Idx values that failed this pass — Retry resumes these only. */
  failed?: number[];
}

export interface GenerateImagesOptions {
  width?: number;
  height?: number;
  model?: string;
  steps?: number;
}

function normalizeImageOptions(options?: GenerateImagesOptions): {
  width: number;
  height: number;
  model: string;
  steps: number;
} {
  const width =
    options?.width !== undefined &&
    Number.isInteger(options.width) &&
    (options.width as number) >= 256 &&
    (options.width as number) <= 2048
      ? (options.width as number)
      : 1080;
  const height =
    options?.height !== undefined &&
    Number.isInteger(options.height) &&
    (options.height as number) >= 256 &&
    (options.height as number) <= 2048
      ? (options.height as number)
      : 1920;
  const model =
    typeof options?.model === "string" && options.model.trim().length > 0
      ? options.model.trim()
      : CLOUDFLARE_DEFAULT_MODEL;
  const steps =
    options?.steps === undefined
      ? CLOUDFLARE_DEFAULT_STEPS
      : normalizeImageSteps(options.steps);
  return { width, height, model, steps };
}

function requireSupabaseForImages(): void {
  if (!isSupabaseConfigured()) {
    throw new Error(
      "Supabase is not configured. Add NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY, then retry."
    );
  }
}

function toSceneImageInput(entry: unknown, fallbackIdx: number): SceneImageInput {
  const row =
    entry !== null && typeof entry === "object"
      ? (entry as Record<string, unknown>)
      : {};
  const idx =
    typeof row.idx === "number" && Number.isFinite(row.idx)
      ? Math.floor(row.idx)
      : fallbackIdx;
  const imagePrompt =
    typeof row.image_prompt === "string"
      ? row.image_prompt
      : typeof row.imagePrompt === "string"
        ? (row.imagePrompt as string)
        : "";
  const seed =
    typeof row.seed === "number" && Number.isFinite(row.seed)
      ? Math.floor(row.seed)
      : 0;
  const imageUrl =
    typeof row.image_url === "string" && row.image_url.length > 0
      ? row.image_url
      : null;
  return { idx, imagePrompt, seed, image_url: imageUrl };
}

/**
 * Pure frontend (no Laravel): download stills for all scenes
 * missing an image, via Cloudflare Workers AI through lib/images.ts.
 * Custom-upload (uploads/…) scenes are skipped; a Retry after a
 * network kill resumes the missing scenes only. Each still is uploaded to
 * Supabase Storage `uploads/` and scenes.image_url is updated (best-effort
 * for anonymous visitors — an in-memory preview URL is returned
 * so the UI keeps working for this session).
 */
export async function generateImages(
  videoId: string,
  options?: GenerateImagesOptions
): Promise<GenerateImagesResult> {
  const cleanId = videoId.trim();
  if (cleanId.length === 0) {
    throw new Error("A video id is required to generate images.");
  }
  requireSupabaseForImages();
  const { width, height, model, steps } = normalizeImageOptions(options);

  let video: unknown = null;
  let rows: unknown[] = [];
  try {
    const videoRes = await supabase
      .from("videos")
      .select("id")
      .eq("id", cleanId)
      .maybeSingle();
    if (videoRes.error) throw videoRes.error;
    video = videoRes.data;
    const scenesRes = await supabase
      .from("scenes")
      .select("idx,image_prompt,seed,image_url")
      .eq("video_id", cleanId)
      .order("idx");
    if (scenesRes.error) throw scenesRes.error;
    rows = Array.isArray(scenesRes.data) ? scenesRes.data : [];
  } catch (err) {
    if (
      err instanceof Error &&
      /video not found|no scenes found/i.test(err.message)
    ) {
      throw err;
    }
    throw new Error(networkErrorMessage());
  }

  if (!video) {
    throw new Error(
      "Video not found. It may have been deleted — please generate the script again."
    );
  }
  if (rows.length === 0) {
    throw new Error(
      "No scenes found for this video. Please generate the script first."
    );
  }

  const inputs = rows.map((entry, index) => {
    const input = toSceneImageInput(entry, index);
    // Mirror backend `empty($scene->seed)` → fresh random seed so the
    // seed+prompt pair stays reproducible once persisted (persistSceneImage
    // writes it back alongside image_url).
    if (!Number.isFinite(input.seed) || input.seed === 0) {
      input.seed = randomImageSeed();
    }
    return input;
  });
  const { images, failed } = await generateAllSceneImages(inputs, {
    videoId: cleanId,
    w: width,
    h: height,
    model,
    steps,
  });
  const resultImages: SceneImage[] = images.map((img) => ({
    idx: img.idx,
    image_url: img.image_url,
    seed: img.seed,
  }));
  return failed.length > 0
    ? { video_id: cleanId, images: resultImages, failed }
    : { video_id: cleanId, images: resultImages };
}

/**
 * Stage 4 (pure frontend — no Laravel): regenerate ONE scene's image with a
 * fresh seed. Only that idx is re-fetched + updated; all other scenes are
 * preserved. Width/height/model default to the current wizard aspect
 * (vertical 1080x1920) so a regen never silently flips orientation.
 */
export async function regenerateScene(
  videoId: string,
  idx: number,
  options?: GenerateImagesOptions
): Promise<GenerateImagesResult> {
  const cleanId = videoId.trim();
  if (cleanId.length === 0) {
    throw new Error("A video id is required to generate images.");
  }
  if (!Number.isInteger(idx) || (idx as number) < 0) {
    throw new Error(
      "Invalid scene index. Please go back to the Images step and retry."
    );
  }
  requireSupabaseForImages();
  const { width, height, model, steps } = normalizeImageOptions(options);

  let rows: unknown[] = [];
  try {
    const scenesRes = await supabase
      .from("scenes")
      .select("idx,image_prompt,seed,image_url")
      .eq("video_id", cleanId)
      .order("idx");
    if (scenesRes.error) throw scenesRes.error;
    rows = Array.isArray(scenesRes.data) ? scenesRes.data : [];
  } catch (err) {
    if (err instanceof Error && /was not found/i.test(err.message)) throw err;
    throw new Error(networkErrorMessage());
  }

  const inputs = rows.map((entry, index) => toSceneImageInput(entry, index));
  const position = inputs.findIndex((scene) => scene.idx === idx);
  if (position === -1) {
    throw new Error(
      `Scene ${idx + 1} was not found. It may have been deleted — please generate the script again.`
    );
  }
  const target = inputs[position];
  if (target.imagePrompt.trim().length === 0) {
    throw new Error(
      "This scene has no image prompt yet. Edit the script first, then retry."
    );
  }

  const newSeed = randomImageSeed();
  const { imageUrl } = await regenerateSceneImage(target.imagePrompt, newSeed, {
    videoId: cleanId,
    w: width,
    h: height,
    model,
    steps,
    storageIdx: idx,
    sceneIdx: position + 1,
    sceneTotal: inputs.length,
  });
  await persistSceneImage(cleanId, idx, imageUrl, newSeed);
  return {
    video_id: cleanId,
    images: [{ idx, image_url: imageUrl, seed: newSeed }],
  };
}

export { API_BASE_URL };

/* ------------------------------------------------------------------ */
/* Stage 3.4 extension — script generation opts + per-scene regenerate */
/* Appended only; existing exports above are untouched.                */
/* ------------------------------------------------------------------ */

export interface EditorSceneDraft {
  idx: number;
  narration: string;
  imagePrompt: string;
  seed: number;
  duration: number;
}

export interface GenerateScriptFullOptions {
  sceneCount?: number;
  durationPerScene?: number;
  aspect?: string;
  negativePrompt?: string;
  customInstructions?: string;
  stylePreset?: string;
  tone?: string;
  language?: string;
  targetAudience?: string;
  apiKey?: string;
  signal?: AbortSignal;
}

export interface GenerateScriptFullResult {
  title: string;
  scenes: EditorSceneDraft[];
  videoId?: string;
}

const API_KEY_STORAGE_KEY = "vidiomaker.openrouter_key";

function readStoredApiKey(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(API_KEY_STORAGE_KEY);
    return stored && stored.trim().length > 0 ? stored.trim() : null;
  } catch {
    return null;
  }
}

function randomSeed(): number {
  return Math.floor(1 + Math.random() * 999999);
}

function toFriendlyError(status: number, detail: string): string {
  if (status === 401 && !detail) {
    return "Invalid API key (401). Update your key in Settings (/settings) and try again.";
  }
  if (status === 404 && !detail) {
    return "Backend endpoint not found (404). Is the backend updated and running?";
  }
  return statusToUserMessage(status, detail);
}

async function readErrorDetail(response: Response): Promise<string> {
  try {
    const payload = await response.json();
    if (
      payload !== null &&
      typeof payload === "object" &&
      "message" in payload &&
      typeof (payload as { message: unknown }).message === "string"
    ) {
      return (payload as { message: string }).message;
    }
  } catch {
    // Ignore JSON parse errors for error responses.
  }
  return "";
}

function normalizeScenes(
  rawScenes: unknown,
  fallbackDuration: number
): EditorSceneDraft[] {
  if (!Array.isArray(rawScenes)) {
    throw new Error("Backend returned an invalid script. Please retry.");
  }
  return rawScenes.map((entry, index) => {
    const row =
      entry !== null && typeof entry === "object"
        ? (entry as Record<string, unknown>)
        : {};
    const narration =
      typeof row.narration === "string" ? row.narration : "";
    const imagePrompt =
      typeof row.imagePrompt === "string"
        ? row.imagePrompt
        : typeof row.image_prompt === "string"
          ? (row.image_prompt as string)
          : "";
    const duration =
      typeof row.duration === "number" && Number.isFinite(row.duration)
        ? row.duration
        : fallbackDuration;
    const seed =
      typeof row.seed === "number" && Number.isFinite(row.seed)
        ? row.seed
        : randomSeed();
    const idx =
      typeof row.idx === "number" && Number.isFinite(row.idx)
        ? row.idx
        : index;
    return { idx, narration, imagePrompt, seed, duration };
  });
}

/**
 * Full script generation with Stage 3 opts (scene count, duration, aspect,
 * negative prompt). Assigns a random seed per scene when the backend omits it
 * (Supabase scenes.seed, needed for regenerate). Auth via Bearer header.
 */
export async function generateScriptWithOptions(
  topic: string,
  model: string,
  options: GenerateScriptFullOptions = {}
): Promise<GenerateScriptFullResult> {
  const cleanTopic = topic.trim();
  if (cleanTopic.length === 0) {
    throw new Error("Please describe your video idea first.");
  }
  if (model.trim().length === 0) {
    throw new Error("Please select a model first.");
  }

  const apiKey = options.apiKey ?? readStoredApiKey();
  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const body: Record<string, unknown> = {
    topic: cleanTopic,
    model: model.trim()
  };
  if (typeof options.sceneCount === "number") {
    body.scene_count = options.sceneCount;
  }
  if (typeof options.durationPerScene === "number") {
    body.duration = options.durationPerScene;
  }
  if (typeof options.aspect === "string" && options.aspect.length > 0) {
    body.aspect = options.aspect;
  }
  if (
    typeof options.negativePrompt === "string" &&
    options.negativePrompt.trim().length > 0
  ) {
    body.negative_prompt = options.negativePrompt.trim();
  }
  if (
    typeof options.customInstructions === "string" &&
    options.customInstructions.trim().length > 0
  ) {
    body.custom_instructions = options.customInstructions.trim().slice(0, 500);
  }
  if (
    typeof options.stylePreset === "string" &&
    options.stylePreset.trim().length > 0
  ) {
    body.style_preset = options.stylePreset.trim().slice(0, 100);
  }
  if (typeof options.tone === "string" && options.tone.trim().length > 0) {
    body.tone = options.tone.trim().slice(0, 100);
  }
  if (
    typeof options.language === "string" &&
    options.language.trim().length > 0
  ) {
    body.language = options.language.trim().slice(0, 100);
  }
  if (
    typeof options.targetAudience === "string" &&
    options.targetAudience.trim().length > 0
  ) {
    body.target_audience = options.targetAudience.trim().slice(0, 100);
  }

  let response: Response;
  try {
    response = await fetch(buildUrl("/api/generate-script"), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: options.signal
    });
  } catch {
    throw new Error(
      networkErrorMessage()
    );
  }

  if (!response.ok) {
    throw new Error(
      toFriendlyError(response.status, await readErrorDetail(response))
    );
  }

  const payload = await response.json();
  const data =
    payload !== null &&
    typeof payload === "object" &&
    "data" in payload &&
    payload.data !== null &&
    typeof (payload as { data: unknown }).data === "object"
      ? (payload as { data: { title?: unknown; scenes?: unknown } }).data
      : (payload as { title?: unknown; scenes?: unknown });

  const fallbackDuration = options.durationPerScene ?? 5;
  const scenes = normalizeScenes(data.scenes, fallbackDuration);
  const title = typeof data.title === "string" ? data.title : cleanTopic;
  // Backend returns video_id (persisted videos row) — surface it so
  // generateImages(videoId) + regenerateScriptScene({videoId}) work.
  const rawId =
    (payload as { video_id?: unknown }).video_id ??
    (data as { video_id?: unknown }).video_id ??
    (data as { videoId?: unknown }).videoId;
  const videoId = typeof rawId === "string" && rawId.length > 0 ? rawId : undefined;
  return { title, scenes, videoId };
}

export interface RegenerateScriptSceneParams {
  idx: number;
  topic?: string;
  model?: string;
  narration?: string;
  imagePrompt?: string;
  videoId?: string;
  customInstructions?: string;
  stylePreset?: string;
  tone?: string;
  language?: string;
  targetAudience?: string;
  signal?: AbortSignal;
}

/**
 * Stage 3: regenerate a single SCRIPT scene's text (idx only). Returns the
 * fresh scene patch — caller must merge it into scenes[idx] WITHOUT touching
 * other scenes. Tries POST /api/regenerate-scene; maps 401/429/422.
 * NOTE: distinct from Stage 4's regenerateScene(videoId, idx) image variant
 * above — different name on purpose so both agents' exports coexist.
 */
export async function regenerateScriptScene(
  params: RegenerateScriptSceneParams
): Promise<Partial<EditorSceneDraft>> {
  const apiKey = readStoredApiKey();
  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  let response: Response;
  try {
    response = await fetch(buildUrl("/api/regenerate-scene"), {
      method: "POST",
      headers,
      body: JSON.stringify({
        idx: params.idx,
        topic: params.topic,
        model: params.model,
        narration: params.narration,
        image_prompt: params.imagePrompt,
        video_id: params.videoId,
        custom_instructions: params.customInstructions?.trim().slice(0, 500) || undefined,
        style_preset: params.stylePreset?.trim().slice(0, 100) || undefined,
        tone: params.tone?.trim().slice(0, 100) || undefined,
        language: params.language?.trim().slice(0, 100) || undefined,
        target_audience: params.targetAudience?.trim().slice(0, 100) || undefined,
      }),
      signal: params.signal
    });
  } catch {
    throw new Error(
      networkErrorMessage()
    );
  }

  if (!response.ok) {
    throw new Error(
      toFriendlyError(response.status, await readErrorDetail(response))
    );
  }

  const payload = await response.json();
  const scene =
    payload !== null &&
    typeof payload === "object" &&
    "data" in payload &&
    payload.data !== null &&
    typeof (payload as { data: unknown }).data === "object"
      ? (payload as { data: Record<string, unknown> }).data
      : (payload as Record<string, unknown>);

  // Accept either { scene: {...} } or the scene object directly.
  const row =
    scene !== null &&
    typeof scene === "object" &&
    "scene" in scene &&
    scene.scene !== null &&
    typeof (scene as { scene: unknown }).scene === "object"
      ? ((scene as { scene: Record<string, unknown> }).scene as Record<
          string,
          unknown
        >)
      : (scene as Record<string, unknown>);

  const patch: Partial<EditorSceneDraft> = {};
  if (typeof row.narration === "string") patch.narration = row.narration;
  if (typeof row.imagePrompt === "string") {
    patch.imagePrompt = row.imagePrompt;
  } else if (typeof row.image_prompt === "string") {
    patch.imagePrompt = row.image_prompt as string;
  }
  if (typeof row.duration === "number" && Number.isFinite(row.duration)) {
    patch.duration = row.duration;
  }
  if (typeof row.seed === "number" && Number.isFinite(row.seed)) {
    patch.seed = row.seed;
  }

  if (
    patch.narration === undefined &&
    patch.imagePrompt === undefined &&
    patch.duration === undefined
  ) {
    throw new Error("Backend returned an empty scene. Please retry.");
  }
  return patch;
}

/* ------------------------------------------------------------------ */
/* Stage 5.5 — Supabase + client-side Canvas/MediaRecorder rendering */
/* Appended only; existing exports above are untouched. No               */
/* No external API base URL is used anywhere in this section.   */
/* Flow: startRender(videoId) marks the Supabase videos row `rendering`, */
/* assembles the MP4 locally via renderVideoClient() (Canvas 2D per-frame */
/* captions + MediaRecorder MP4, no wasm), uploads the Blob to the Supabase  */
/* Storage `renders/` bucket, then marks the row `done` (+ render_path).*/
/* fetchVideoStatus reads the row; pollVideoStatus polls it every 3s.   */
/* ------------------------------------------------------------------ */

export type VideoStatus = "draft" | "queued" | "rendering" | "done" | "failed";

export interface VideoRecord {
  id: string;
  title: string | null;
  topic: string | null;
  model_id: string | null;
  status: string;
  created_at: string | null;
  video_url?: string | null;
  download_url?: string | null;
  url?: string | null;
  scenes_count?: number | null;
}

export interface VideoStatusResult {
  status: string;
  videoUrl: string | null;
  message: string | null;
  progress: number | null;
  raw: unknown;
}

export interface PollVideoStatusOptions {
  /** Poll cadence in ms. Defaults to 3000 (Stage 5 acceptance). */
  intervalMs?: number;
  signal?: AbortSignal;
  onUpdate?: (update: VideoStatusResult) => void;
}

/** Status polling cadence (Stage 5.3: poll every 3s). */
export const VIDEO_STATUS_POLL_INTERVAL_MS = 3000;

/** Supabase Storage bucket holding final MP4s (path: renders/{videoId}.mp4). */
const RENDERS_BUCKET = "renders";

const RENDER_HISTORY_LIMIT = 50;

function requireSupabaseConfigured(): void {
  if (!isSupabaseConfigured()) {
    throw new Error(
      "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL + " +
        "NEXT_PUBLIC_SUPABASE_ANON_KEY in frontend/.env.local, then retry.",
    );
  }
}

function storagePathFor(videoId: string): string {
  return `${videoId}.mp4`;
}

/**
 * Public playback URL for a rendered video. Requires the `renders` bucket
 * to be public; for private buckets use getVideoSignedUrl() instead.
 * Sync (no fetch) so it stays a drop-in href for <video> + download anchors.
 */
function publicRenderUrl(videoId: string): string {
  return supabase.storage.from(RENDERS_BUCKET).getPublicUrl(storagePathFor(videoId))
    .data.publicUrl;
}

/**
 * Best-effort status write. Resolves even when RLS (anon key is read-only
 * per supabase/schema.sql) rejects the write — the local render + upload
 * still proceed so a locked-down policy can never brick a render; the
 * failure is logged for ops instead of shown to the user.
 */
async function tryMarkVideoRow(
  videoId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  try {
    const { error } = await supabase.from("videos").update(patch).eq("id", videoId);
    if (error) {
      // eslint-disable-next-line no-console
      console.warn(`[render] status write skipped (${error.message})`);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[render] status write skipped.", err);
  }
}

/** Load ordered render scenes for a video from Supabase (primary source). */
async function loadSupabaseRenderScenes(
  videoId: string,
): Promise<RenderSceneInput[]> {
  const { data, error } = await supabase
    .from("scenes")
    .select("image_url, narration, duration")
    .eq("video_id", videoId)
    .order("idx", { ascending: true });
  if (error) {
    throw new Error(
      `Could not load scenes (${error.message}). Check your connection and retry.`,
    );
  }
  const rows = (data ?? []) as Array<{
    image_url?: unknown;
    narration?: unknown;
    duration?: unknown;
  }>;
  return rows
    .filter(
      (row) =>
        typeof row.image_url === "string" && row.image_url.trim().length > 0,
    )
    .map((row) => ({
      imageUrl: (row.image_url as string).trim(),
      narration:
        typeof row.narration === "string" && row.narration.length > 0
          ? row.narration
          : "",
      duration:
        typeof row.duration === "number" && Number.isFinite(row.duration)
          ? row.duration
          : 5,
    }));
}

/** Resolve the playable URL from a Supabase videos row (any shape). */
function videoUrlFromRow(
  row: Record<string, unknown>,
  videoId: string,
): string | null {
  for (const key of ["video_url", "download_url", "url"]) {
    const value = row[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  if (typeof row.render_path === "string" && row.render_path.length > 0) {
    return publicRenderUrl(videoId);
  }
  return null;
}

function toFiniteNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export interface StartRenderOptions {
  /** Output orientation (defaults to vertical 1080x1920 Shorts). */
  aspect?: RenderAspect;
  /**
   * In-memory scenes override (wizard stills + edited narrations). When
   * omitted or empty, scenes are loaded from the Supabase `scenes` table.
   */
  scenes?: RenderSceneInput[];
  /** Optional TTS MP3 URLs, index-aligned (stub: silent when omitted). */
  audioUrls?: string[];
  signal?: AbortSignal;
  /** 0–100 local encode progress (Supabase progress writes are throttled). */
  onProgress?: (progress: number) => void;
}

/**
 * Client-side render: marks the Supabase videos row `rendering`,
 * assembles the MP4 locally via renderVideoClient() (Canvas 2D per-frame
 * captions + MediaRecorder MP4, no wasm), uploads the Blob to the Supabase
 * Storage `renders/` bucket, then marks the row `done` (+ render_path).
 * Resolves with the terminal snapshot — no polling needed in the same tab
 * (other tabs follow via pollVideoStatus). Images are never cleared, so
 * Retry resumes without regenerating anything.
 */
export async function startRender(
  videoId: string,
  options: StartRenderOptions = {},
): Promise<VideoStatusResult> {
  if (videoId.trim().length === 0) {
    throw new Error("No video to render yet. Generate a script first.");
  }
  requireSupabaseConfigured();
  if (options.signal?.aborted) throw new Error("Status polling stopped.");

  await tryMarkVideoRow(videoId, {
    status: "rendering",
    progress: 5,
    error_log: null,
  });

  const override = (options.scenes ?? []).filter(
    (scene) =>
      scene &&
      typeof scene.imageUrl === "string" &&
      scene.imageUrl.trim().length > 0,
  );
  const scenes =
    override.length > 0 ? override : await loadSupabaseRenderScenes(videoId);
  if (scenes.length === 0) {
    const message =
      "This video has no scene images yet. Generate images first, then render.";
    await tryMarkVideoRow(videoId, { status: "failed", error_log: message });
    throw new Error(message);
  }

  let lastPushed = 5;
  const pushProgress = (value: number): void => {
    options.onProgress?.(value);
    // Throttle Supabase writes to ~10% steps (fire-and-forget, never blocks).
    if (value - lastPushed >= 10 || value >= 100) {
      lastPushed = value;
      void tryMarkVideoRow(videoId, { progress: value });
    }
  };

  let blob: Blob;
  try {
    blob = await renderVideoClient({
      scenes,
      aspect: options.aspect ?? "1080x1920",
      audioUrls: options.audioUrls,
      signal: options.signal,
      onProgress: pushProgress,
    });
  } catch (err) {
    const message =
      err instanceof Error && err.message.trim().length > 0
        ? err.message
        : "Render failed. Your images are kept — tap Retry to run it again.";
    await tryMarkVideoRow(videoId, { status: "failed", error_log: message });
    throw err instanceof Error ? err : new Error(message);
  }

  // Upload to the `renders/` bucket; when Storage rejects the write (e.g.
  // missing bucket/policy), fall back to a local object URL so the <video>
  // preview + download still work in this session.
  let videoUrl: string | null = null;
  try {
    const { error: uploadError } = await supabase.storage
      .from(RENDERS_BUCKET)
      .upload(storagePathFor(videoId), blob, {
        // Respect the recorder's actual container (video/mp4 on the MP4
        // path; video/webm on the Firefox fallback) so Storage serves the
        // right Content-Type to <video> + download.
        contentType: blob.type || "video/mp4",
        upsert: true,
      });
    if (uploadError) throw new Error(uploadError.message);
    videoUrl = publicRenderUrl(videoId);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[render] Storage upload skipped, using a local preview URL.", err);
    try {
      videoUrl = URL.createObjectURL(blob);
    } catch {
      videoUrl = null;
    }
  }

  await tryMarkVideoRow(videoId, {
    status: "done",
    progress: 100,
    render_path: `${RENDERS_BUCKET}/${storagePathFor(videoId)}`,
    // Best-effort forward-compat: ignored when the column does not exist
    // (supabase/schema.sql tracks render_path; see tryMarkVideoRow).
    video_url: videoUrl,
  });

  return {
    status: "done",
    videoUrl,
    message: "Render complete. Your video is ready to preview and download.",
    progress: 100,
    raw: { video_id: videoId, render_path: `${RENDERS_BUCKET}/${storagePathFor(videoId)}` },
  };
}

/**
 * History "Regenerate" — same client-side pass as startRender (fresh
 * Canvas/MediaRecorder assembly, scenes kept), separate name for UI semantics.
 */
export async function regenerateVideo(
  videoId: string,
  options: StartRenderOptions = {},
): Promise<VideoStatusResult> {
  return startRender(videoId, options);
}

/** Single status snapshot from the Supabase videos row (+ Storage URL). */
export async function fetchVideoStatus(
  videoId: string,
): Promise<VideoStatusResult> {
  requireSupabaseConfigured();
  let row: Record<string, unknown> | null = null;
  try {
    const { data, error } = await supabase
      .from("videos")
      .select("*")
      .eq("id", videoId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    row = (data ?? null) as Record<string, unknown> | null;
  } catch (err) {
    if (err instanceof Error && /not configured/i.test(err.message)) throw err;
    throw new Error(networkErrorMessage());
  }
  if (!row) {
    throw new Error("Video not found. It may have been deleted already.");
  }
  const status =
    typeof row.status === "string" && row.status.length > 0
      ? row.status
      : "draft";
  const videoUrl =
    status === "done" ? videoUrlFromRow(row, videoId) : null;
  const message =
    typeof row.error_log === "string" && row.error_log.length > 0 && status === "failed"
      ? row.error_log
      : status === "done"
        ? "Render complete. Your video is ready to preview and download."
        : status === "rendering"
          ? "Rendering in progress. Keep this tab open — polling every 3 seconds."
          : status === "queued"
            ? "Render queued. Polling every 3 seconds for progress."
            : null;
  return {
    status,
    videoUrl,
    message,
    progress: toFiniteNumberOrNull(row.progress),
    raw: row,
  };
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Status polling stopped."));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new Error("Status polling stopped."));
    }
    signal?.addEventListener("abort", onAbort);
  });
}

/**
 * Poll the Supabase videos row every 3s until `done`/`failed`.
 * Transient network blips are tolerated (up to 5 in a row); terminal
 * states resolve; abort or a ~12min cap rejects with a friendly error.
 * (Same signature/cadence as the old backend poller — VideoPreview is
 * untouched apart from the new client-side render path.)
 */
export async function pollVideoStatus(
  videoId: string,
  options: PollVideoStatusOptions = {}
): Promise<VideoStatusResult> {
  const intervalMs = options.intervalMs ?? VIDEO_STATUS_POLL_INTERVAL_MS;
  const maxAttempts = 240;
  let attempts = 0;
  let consecutiveErrors = 0;
  for (;;) {
    if (options.signal?.aborted) throw new Error("Status polling stopped.");
    let update: VideoStatusResult;
    try {
      update = await fetchVideoStatus(videoId);
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors += 1;
      if (consecutiveErrors > 5) throw err;
      await sleepWithAbort(intervalMs, options.signal);
      continue;
    }
    options.onUpdate?.(update);
    if (update.status === "done" || update.status === "failed") return update;
    attempts += 1;
    if (attempts >= maxAttempts) {
      throw new Error(
        "Render is taking too long. Please check History later or retry."
      );
    }
    await sleepWithAbort(intervalMs, options.signal);
  }
}

/**
 * List videos for History (newest first) straight from Supabase.
 * Playback URLs resolve via the `renders/` bucket public URL.
 */
export async function fetchVideoHistory(): Promise<VideoRecord[]> {
  requireSupabaseConfigured();
  let rows: Record<string, unknown>[];
  try {
    const { data, error } = await supabase
      .from("videos")
      .select("id, title, topic, model_id, status, created_at, render_path")
      .order("created_at", { ascending: false })
      .limit(RENDER_HISTORY_LIMIT);
    if (error) throw new Error(error.message);
    rows = ((data ?? []) as Record<string, unknown>[]);
  } catch (err) {
    if (err instanceof Error && /not configured/i.test(err.message)) throw err;
    throw new Error(networkErrorMessage());
  }
  const records: VideoRecord[] = [];
  for (const row of rows) {
    const id = typeof row.id === "string" && row.id.length > 0 ? row.id : null;
    if (!id) continue;
    const textOrNull = (value: unknown): string | null =>
      typeof value === "string" && value.length > 0 ? value : null;
    const playable =
      row.status === "done" ? publicRenderUrl(id) : null;
    records.push({
      id,
      title: textOrNull(row.title),
      topic: textOrNull(row.topic),
      model_id: textOrNull(row.model_id),
      status:
        typeof row.status === "string" && row.status.length > 0
          ? row.status
          : "draft",
      created_at: textOrNull(row.created_at),
      video_url: playable,
      download_url: playable,
      url: playable,
      scenes_count: null,
    });
  }
  return records;
}

/** Delete a video: Storage MP4 (best-effort) + scenes + the videos row. */
export async function deleteVideo(videoId: string): Promise<void> {
  requireSupabaseConfigured();
  try {
    // Best-effort: a missing object must not block the row delete.
    await supabase.storage.from(RENDERS_BUCKET).remove([storagePathFor(videoId)]);
  } catch {
    // Ignore — the DB rows below are the source of truth for History.
  }
  try {
    const { error: scenesError } = await supabase
      .from("scenes")
      .delete()
      .eq("video_id", videoId);
    if (scenesError) throw new Error(scenesError.message);
    const { error: videoError } = await supabase
      .from("videos")
      .delete()
      .eq("id", videoId);
    if (videoError) throw new Error(videoError.message);
  } catch (err) {
    if (err instanceof Error && /not configured/i.test(err.message)) throw err;
    throw new Error(
      err instanceof Error && err.message.trim().length > 0
        ? err.message
        : "Video could not be deleted. Please try again.",
    );
  }
}

/**
 * Direct download/playback URL for a rendered video (public `renders/`
 * bucket, no backend). Sync so it stays a drop-in anchor href.
 */
export function getVideoDownloadUrl(videoId: string): string {
  return publicRenderUrl(videoId);
}

/**
 * Time-limited signed URL for a rendered video (private `renders/`
 * bucket). Prefer this over getVideoDownloadUrl() when the bucket is
 * not public.
 */
export async function getVideoSignedUrl(
  videoId: string,
  expiresInSeconds = 3600,
): Promise<string> {
  requireSupabaseConfigured();
  const { data, error } = await supabase.storage
    .from(RENDERS_BUCKET)
    .createSignedUrl(storagePathFor(videoId), expiresInSeconds);
  if (error || !data?.signedUrl) {
    throw new Error(
      error?.message
        ? `Could not create a download link (${error.message}).`
        : "Could not create a download link. The render may not be uploaded yet.",
    );
  }
  return data.signedUrl;
}
