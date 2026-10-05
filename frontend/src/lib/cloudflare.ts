/**
 * Vidiomaker — Cloudflare Workers AI image client (frontend only).
 *
 * The browser only talks to our same-origin proxy
 * `POST /api/generate-image`, which holds the Account ID + API token
 * server-side (never in the browser, never in URLs, never logged).
 *
 * Matches the style of `lib/api.ts` / `lib/openrouter.ts`:
 * small helpers, friendly user-facing errors, SSR-safe storage guards.
 * Scene progress strings come from lib/errors.ts so every retry reads
 * exactly like "Cloudflare timed out, retrying scene 2/5...".
 */

import { cloudflareSceneMessage } from "./errors";

/** The 4 selectable text-to-image models (exact Workers AI ids). */
export interface CloudflareImageModel {
  id: string;
  label: string;
  hint: string;
}

export const CLOUDFLARE_IMAGE_MODELS: CloudflareImageModel[] = [
  {
    id: "@cf/black-forest-labs/flux-1-schnell",
    label: "FLUX.1 Schnell",
    hint: "Fastest + cheapest — best default for drafts.",
  },
  {
    id: "@cf/black-forest-labs/flux-2-klein-4b",
    label: "FLUX.2 Klein 4B",
    hint: "Fast + light — quick previews with better detail.",
  },
  {
    id: "@cf/black-forest-labs/flux-2-klein-9b",
    label: "FLUX.2 Klein 9B",
    hint: "Balanced quality — good default for final videos.",
  },
  {
    id: "@cf/black-forest-labs/flux-2-dev",
    label: "FLUX.2 Dev",
    hint: "Best quality — slower, use for hero scenes.",
  },
];

export const CLOUDFLARE_DEFAULT_MODEL = "@cf/black-forest-labs/flux-1-schnell";

/** localStorage key for the inference-steps setting (Settings → Images). */
export const IMAGE_STEPS_STORAGE_KEY = "vidiomaker.image_steps";

/** Diffusion steps range (matches POST /api/generate-image clamp 1–8). */
export const CLOUDFLARE_MIN_STEPS = 1;
export const CLOUDFLARE_MAX_STEPS = 8;
export const CLOUDFLARE_DEFAULT_STEPS = 4;

/** localStorage key for the website image-model picker. */
export const IMAGE_MODEL_STORAGE_KEY = "vidiomaker.image_model";

export const CLOUDFLARE_TIMEOUT_MS = 60000;
export const CLOUDFLARE_MAX_RETRIES = 2;

/** Base delays for exponential backoff: 2s -> 4s -> 8s. */
const RETRY_BASE_DELAY_MS = 2000;

const GENERATE_ROUTE = "/api/generate-image";

/** In-memory object-URL cache (blob: URLs, per session only). */
const MEMORY_CACHE = new Map<string, string>();

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** True when the id is one of the 4 supported Workers AI models. */
export function isSupportedImageModel(model: string): boolean {
  return CLOUDFLARE_IMAGE_MODELS.some((m) => m.id === model);
}

/** Normalize any stored/selected value to a supported id (else default). */
export function normalizeImageModel(model: unknown): string {
  if (typeof model === "string" && isSupportedImageModel(model.trim())) {
    return model.trim();
  }
  return CLOUDFLARE_DEFAULT_MODEL;
}

/** Read the website picker selection (localStorage), or the default. */
export function readStoredImageModel(): string {
  if (!isBrowser()) return CLOUDFLARE_DEFAULT_MODEL;
  try {
    return normalizeImageModel(
      window.localStorage.getItem(IMAGE_MODEL_STORAGE_KEY)
    );
  } catch {
    return CLOUDFLARE_DEFAULT_MODEL;
  }
}

/** Persist the website picker selection (best-effort, never throws). */
export function storeImageModel(model: string): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(
      IMAGE_MODEL_STORAGE_KEY,
      normalizeImageModel(model)
    );
  } catch {
    // Private mode / quota — selection still works in-memory.
  }
}

/** Clamp any value to the 1–8 steps range (else the default 4). */
export function normalizeImageSteps(value: unknown): number {
  const num =
    typeof value === "string" && value.trim().length > 0
      ? Number(value)
      : typeof value === "number"
        ? value
        : NaN;
  if (!Number.isFinite(num)) return CLOUDFLARE_DEFAULT_STEPS;
  return Math.min(
    CLOUDFLARE_MAX_STEPS,
    Math.max(CLOUDFLARE_MIN_STEPS, Math.round(num))
  );
}

/** Read the Settings → Images steps value (localStorage), or the default. */
export function readStoredImageSteps(): number {
  if (!isBrowser()) return CLOUDFLARE_DEFAULT_STEPS;
  try {
    return normalizeImageSteps(
      window.localStorage.getItem(IMAGE_STEPS_STORAGE_KEY)
    );
  } catch {
    return CLOUDFLARE_DEFAULT_STEPS;
  }
}

/** Persist the steps setting (best-effort, never throws). */
export function storeImageSteps(steps: number): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(
      IMAGE_STEPS_STORAGE_KEY,
      String(normalizeImageSteps(steps))
    );
  } catch {
    // Private mode / quota — in-memory value still applies this session.
  }
}

/** Cache key: seed + prompt + dimensions + model + steps. */
export function buildCacheKey(
  prompt: string,
  seed: number,
  w = 1080,
  h = 1920,
  model: string = CLOUDFLARE_DEFAULT_MODEL,
  steps: number = CLOUDFLARE_DEFAULT_STEPS
): string {
  return `${Math.floor(seed)}::${w}x${h}::${normalizeImageModel(model)}::${normalizeImageSteps(steps)}::${prompt.trim()}`;
}

function rememberObjectUrl(cacheKey: string, objectUrl: string): void {
  const previous = MEMORY_CACHE.get(cacheKey);
  if (previous && previous.startsWith("blob:") && previous !== objectUrl) {
    try {
      URL.revokeObjectURL(previous);
    } catch {
      // Ignore revoke errors.
    }
  }
  MEMORY_CACHE.set(cacheKey, objectUrl);
}

/** Return a cached object URL for a seed+prompt+w+h+model+steps combo, or null. */
export function getCachedUrl(
  prompt: string,
  seed: number,
  w = 1080,
  h = 1920,
  model: string = CLOUDFLARE_DEFAULT_MODEL,
  steps: number = CLOUDFLARE_DEFAULT_STEPS
): string | null {
  return MEMORY_CACHE.get(buildCacheKey(prompt, seed, w, h, model, steps)) ?? null;
}

/** Clear the in-memory object-URL cache. */
export function clearCache(): void {
  for (const url of MEMORY_CACHE.values()) {
    if (url.startsWith("blob:") && isBrowser()) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // Ignore revoke errors.
      }
    }
  }
  MEMORY_CACHE.clear();
}

export interface FetchWithRetryOptions {
  /** Per-attempt timeout in ms (default 60000 — image diffusion is slow). */
  timeoutMs?: number;
  /** 1-based scene index, used only for friendly error messages. */
  sceneIdx?: number;
  /** Total scene count, used only for friendly error messages. */
  sceneTotal?: number;
  /** Diffusion steps 1–8 (Settings → Images). Sent to schnell + FLUX.2 Dev; klein stays fixed at 4. */
  steps?: number;
  /** Optional external abort signal (combined with the per-attempt timeout). */
  signal?: AbortSignal;
}

function friendlyRetryError(
  options: FetchWithRetryOptions,
  timedOut: boolean
): Error {
  const { sceneIdx, sceneTotal } = options;
  return new Error(cloudflareSceneMessage(timedOut, sceneIdx, sceneTotal));
}

function isConfigErrorMessage(message: string): boolean {
  return /not configured|CLOUDFLARE_ACCOUNT_ID|CLOUDFLARE_API_TOKEN|invalid.*credential/i.test(
    message
  );
}

/**
 * POST one prompt to the same-origin proxy with exponential backoff
 * (2s -> 4s -> 8s) and a 60s per-attempt timeout via AbortController.
 *
 * Retries network errors plus HTTP 429/5xx. Other 4xx responses throw
 * immediately since retrying will not help (except 429 rate-limit).
 * Server-misconfiguration (missing Cloudflare credentials) throws
 * immediately with the setup hint — retrying cannot fix it.
 */
export async function fetchWithRetry(
  prompt: string,
  seed: number,
  w: number,
  h: number,
  model: string,
  retries = CLOUDFLARE_MAX_RETRIES,
  options: FetchWithRetryOptions = {}
): Promise<Blob> {
  const cleanPrompt = (prompt ?? "").trim();
  if (cleanPrompt.length === 0) {
    throw new Error("Please describe the scene image first.");
  }
  if (!Number.isFinite(seed)) {
    throw new Error("Invalid seed. Please regenerate the scene seed.");
  }
  const timeoutMs = options.timeoutMs ?? CLOUDFLARE_TIMEOUT_MS;
  const steps =
    options.steps === undefined ? null : normalizeImageSteps(options.steps);
  const maxAttempts = Math.max(1, Math.floor(retries) + 1);
  let timedOut = false;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const onExternalAbort = () => controller.abort();
    if (options.signal) {
      if (options.signal.aborted) {
        clearTimeout(timer);
        throw new Error("Image request was cancelled. Please retry.");
      }
      options.signal.addEventListener("abort", onExternalAbort, { once: true });
    }

    try {
      const res = await fetch(GENERATE_ROUTE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: cleanPrompt,
          seed: Math.floor(seed),
          width: w,
          height: h,
          model: normalizeImageModel(model),
          ...(steps !== null ? { steps } : {}),
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (options.signal) {
        options.signal.removeEventListener("abort", onExternalAbort);
      }

      if (res.ok) {
        const blob = await res.blob();
        if (blob.size === 0) {
          throw new Error("empty-response");
        }
        return blob;
      }

      // Read the server's friendly `message` when available.
      let detail = "";
      try {
        const payload = (await res.clone().json()) as {
          message?: unknown;
        };
        if (typeof payload?.message === "string" && payload.message.length > 0) {
          detail = payload.message;
        }
      } catch {
        // Non-JSON error body — fall through to status mapping.
      }

      // Missing Cloudflare credentials: fail fast with the setup hint.
      if (res.status === 422 && isConfigErrorMessage(detail)) {
        throw new Error(detail);
      }
      // Do not retry deterministic client errors (except rate-limit 429).
      if (res.status !== 429 && res.status >= 400 && res.status < 500) {
        throw new Error(
          detail ||
            `Cloudflare could not render this prompt (${res.status}). Try simplifying the prompt.`
        );
      }
      // 429/5xx → retry with backoff below.
      if (attempt === maxAttempts - 1) {
        throw new Error(
          detail || `Cloudflare responded with ${res.status}.`
        );
      }
    } catch (err) {
      clearTimeout(timer);
      if (options.signal) {
        options.signal.removeEventListener("abort", onExternalAbort);
      }
      if (options.signal?.aborted) {
        throw new Error("Image request was cancelled. Please retry.");
      }
      if (err instanceof Error) {
        // Fail-fast paths: config + deterministic client errors.
        if (
          isConfigErrorMessage(err.message) ||
          /^Cloudflare could not render/.test(err.message)
        ) {
          throw err;
        }
        if (err.name === "AbortError") {
          timedOut = true;
        }
      }
      const isLast = attempt === maxAttempts - 1;
      if (isLast) break;
      // Exponential backoff: 2s -> 4s -> 8s.
      await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
      continue;
    }

    const isLast = attempt === maxAttempts - 1;
    if (isLast) break;
    await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
  }

  // One short actionable line for every path (timeout vs busy is carried
  // by the timedOut flag); full detail stays in server logs.
  throw friendlyRetryError(options, timedOut);
}

export interface FetchSceneImageOptions extends FetchWithRetryOptions {
  w?: number;
  h?: number;
  /** One of the 4 CLOUDFLARE_IMAGE_MODELS ids. */
  model?: string;
  /** Skip cache read/write when false (default true). */
  useCache?: boolean;
}

/**
 * Fetch one scene image via Cloudflare Workers AI (through the
 * same-origin proxy) and return a Blob.
 *
 * Throws a friendly per-scene error (via cloudflareSceneMessage) on
 * total failure. No deterministic URL exists for Cloudflare (unlike the
 * old GET-URL provider) — the caller decides how to persist/reference
 * the bytes (object URL for preview, Supabase Storage for render).
 */
export async function fetchSceneImageBlob(
  prompt: string,
  seed: number,
  options: FetchSceneImageOptions = {}
): Promise<Blob> {
  const w = options.w ?? 1080;
  const h = options.h ?? 1920;
  const model = normalizeImageModel(options.model ?? CLOUDFLARE_DEFAULT_MODEL);
  const retries = CLOUDFLARE_MAX_RETRIES;

  const cleanPrompt = (prompt ?? "").trim();
  if (cleanPrompt.length === 0) {
    throw new Error("Please describe the scene image first.");
  }

  const steps =
    options.steps === undefined ? null : normalizeImageSteps(options.steps);
  // eslint-disable-next-line no-console
  console.info(
    `[cloudflare] fetching scene seed=${Math.floor(seed)} model=${model} ${w}x${h}${steps !== null ? ` steps=${steps}` : ""}`
  );
  return fetchWithRetry(prompt, seed, w, h, model, retries, options);
}

/**
 * Fetch one scene image and return an in-memory object URL, using the
 * per-session cache. Prefer `fetchSceneImageBlob` + Supabase upload
 * (lib/images.ts) when you need a persistent URL — object URLs die
 * with the tab.
 */
export async function fetchSceneImage(
  prompt: string,
  seed: number,
  options: FetchSceneImageOptions = {}
): Promise<string> {
  const w = options.w ?? 1080;
  const h = options.h ?? 1920;
  const model = normalizeImageModel(options.model ?? CLOUDFLARE_DEFAULT_MODEL);
  const steps =
    options.steps === undefined
      ? CLOUDFLARE_DEFAULT_STEPS
      : normalizeImageSteps(options.steps);
  const useCache = options.useCache ?? true;

  if (useCache) {
    const hit = getCachedUrl(prompt, seed, w, h, model, steps);
    if (hit) return hit;
  }

  const blob = await fetchSceneImageBlob(prompt, seed, {
    ...options,
    steps,
    useCache: false,
  });
  if (!isBrowser()) {
    throw new Error("Image preview needs a browser. Please retry.");
  }
  const objectUrl = URL.createObjectURL(blob);
  if (useCache) {
    rememberObjectUrl(buildCacheKey(prompt, seed, w, h, model, steps), objectUrl);
  }
  return objectUrl;
}
