// Vidiomaker — OpenRouter client helpers (frontend only, no secrets committed).
// Agent 1 (Vercel-native): same-origin Next.js Route Handlers are the only
// backend. No Laravel, no env-based API base URL, no PHP anywhere in this path.
// Stage 6.3: all user-facing strings funnel through lib/errors.ts.

import {
  networkErrorMessage,
  statusToUserMessage,
  toUserMessage,
} from "./errors";

export interface OpenRouterModelPricing {
  prompt: string;
  completion: string;
  request?: string;
  image?: string;
  [extra: string]: string | undefined;
}

export interface OpenRouterModel {
  id: string;
  name: string;
  description?: string;
  context_length?: number;
  architecture?: {
    modality?: string;
    input_modalities?: string[];
    output_modalities?: string[];
    tokenizer?: string;
    [extra: string]: unknown;
  };
  pricing: OpenRouterModelPricing;
  top_provider?: {
    context_length?: number;
    max_completion_tokens?: number | null;
    [extra: string]: unknown;
  };
  per_request_limits?: Record<string, unknown> | null;
  [extra: string]: unknown;
}

export interface GeneratedScene {
  narration: string;
  imagePrompt: string;
  duration: number;
}

export interface GeneratedScript {
  title: string;
  scenes: GeneratedScene[];
}

export const MODEL_STORAGE_KEY = "vidiomaker.model";
export const API_KEY_STORAGE_KEY = "vidiomaker.openrouter_key";

const MODELS_ROUTE = "/api/models";
const GENERATE_ROUTE = "/api/generate-script";
const DIRECT_MODELS_URL = "https://openrouter.ai/api/v1/models";

function normalizeModelList(payload: unknown): OpenRouterModel[] {
  if (Array.isArray(payload)) {
    return payload as OpenRouterModel[];
  }
  if (payload !== null && typeof payload === "object" && "data" in payload) {
    const data = (payload as { data: unknown }).data;
    if (Array.isArray(data)) {
      return data as OpenRouterModel[];
    }
  }
  throw new Error("Model list response had an unexpected shape. Please retry.");
}

function readStoredApiKey(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(API_KEY_STORAGE_KEY);
    return stored && stored.trim().length > 0 ? stored.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Fetch the live OpenRouter model list.
 * Preferred: same-origin Vercel route (GET /api/models, cached 1h server-side).
 * Fallback: direct OpenRouter public list if the route is unreachable.
 */
export async function fetchOpenRouterModels(): Promise<OpenRouterModel[]> {
  let routeError: unknown = null;

  try {
    const res = await fetch(MODELS_ROUTE);
    if (!res.ok) {
      throw new Error(
        `Model list failed (${res.status}). Showing cached list where available.`
      );
    }
    const payload = await res.json();
    return normalizeModelList(payload);
  } catch (err) {
    routeError = err;
  }

  // Direct fallback (public endpoint, no key needed for listing).
  try {
    const directRes = await fetch(DIRECT_MODELS_URL);
    if (!directRes.ok) {
      throw new Error(
        statusToUserMessage(
          directRes.status,
          `Model list failed (${directRes.status}). Please check your connection and retry.`
        )
      );
    }
    const payload = await directRes.json();
    return normalizeModelList(payload);
  } catch (err) {
    if (routeError instanceof Error) throw routeError;
    throw new Error(
      toUserMessage(
        err,
        "Could not load models. The model service is unavailable. Please retry."
      )
    );
  }
}

export interface GenerateScriptOptions {
  apiKey?: string;
  sceneCount?: number;
  durationPerScene?: number;
  aspect?: string;
  negativePrompt?: string;
  customInstructions?: string;
  stylePreset?: string;
  tone?: string;
  language?: string;
  targetAudience?: string;
  signal?: AbortSignal;
}

/**
 * POST a script generation request to the Vercel route.
 * The API key (if set) is sent as a Bearer header — never in the URL.
 */
export async function generateScript(
  topic: string,
  model: string,
  options: GenerateScriptOptions = {}
): Promise<GeneratedScript> {
  const cleanTopic = topic.trim();
  if (cleanTopic.length === 0) {
    throw new Error("Please describe your video idea first.");
  }
  if (model.trim().length === 0) {
    throw new Error("Please select a model first.");
  }

  const apiKey = options.apiKey ?? readStoredApiKey();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const body: Record<string, unknown> = {
    topic: cleanTopic,
    model: model.trim(),
  };
  // Same body keys as lib/api.ts generateScriptWithOptions (the Vercel route
  // accepts both camelCase and snake_case) — keeps the two clients in sync (DRY).
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

  let res: Response;
  try {
    res = await fetch(GENERATE_ROUTE, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: options.signal,
    });
  } catch {
    throw new Error(networkErrorMessage());
  }

  if (!res.ok) {
    let detail = "";
    try {
      const errPayload = await res.json();
      if (
        errPayload !== null &&
        typeof errPayload === "object" &&
        "message" in errPayload &&
        typeof (errPayload as { message: unknown }).message === "string"
      ) {
        detail = (errPayload as { message: string }).message;
      }
    } catch {
      // Ignore JSON parse errors for error responses.
    }

    // 401 → Settings link, 429 → auto-retry countdown (rendered by ErrorAlert).
    if (res.status === 401 && !detail) {
      detail = "Invalid API key (401). Update your key in Settings (/settings) and try again.";
    }
    throw new Error(statusToUserMessage(res.status, detail));
  }

  const payload = await res.json();
  // Route returns the script flat (video_id/title/scenes); older shapes may
  // wrap it in { data: ... }. Accept both.
  const script =
    payload !== null &&
    typeof payload === "object" &&
    "data" in payload &&
    payload.data !== null &&
    typeof (payload as { data: unknown }).data === "object" &&
    !("video_id" in payload)
      ? (payload as { data: GeneratedScript }).data
      : (payload as GeneratedScript);

  if (!script || !Array.isArray(script.scenes)) {
    throw new Error("Server returned an invalid script. Please retry.");
  }
  return script;
}
