/**
 * Agent 1 — client helper for POST /api/rewrite-image-prompt.
 *
 * Rewrites ONE scene's imagePrompt (optional userHint). Returns the fresh
 * prompt — the caller merges it into scenes[idx] WITHOUT touching other
 * scenes, then (Agent 2) remakes that scene's image.
 *
 * Auth mirrors lib/api.ts: Bearer token from localStorage
 * "vidiomaker.openrouter_key". Plain-text prompts only (XSS-safe).
 */

import { networkErrorMessage, statusToUserMessage } from "./errors";

const REWRITE_URL = "/api/rewrite-image-prompt";
const API_KEY_STORAGE_KEY = "vidiomaker.openrouter_key";

export interface RewriteImagePromptParams {
  idx: number;
  imagePrompt: string;
  narration?: string;
  topic?: string;
  userHint?: string;
  stylePreset?: string;
  tone?: string;
  aspect?: string;
  model?: string;
  signal?: AbortSignal;
}

export interface RewriteImagePromptResult {
  idx: number;
  imagePrompt: string;
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

/** Placeholder hint for the optional "what to change" input. */
export function buildUserHintPlaceholder(): string {
  return "e.g. make it sunset, more cinematic…";
}

/**
 * POST the current imagePrompt (+ optional hint/context) and resolve with
 * the rewritten prompt for that idx only.
 */
export async function rewriteImagePrompt(
  params: RewriteImagePromptParams,
): Promise<RewriteImagePromptResult> {
  if (!Number.isInteger(params.idx) || params.idx < 0 || params.idx > 50) {
    throw new Error("Invalid scene index. Please go back and retry.");
  }
  if (!params.imagePrompt || params.imagePrompt.trim().length === 0) {
    throw new Error("Please describe the scene image first.");
  }

  const apiKey = readStoredApiKey();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const body: Record<string, unknown> = {
    idx: params.idx,
    imagePrompt: params.imagePrompt.trim().slice(0, 2048),
  };
  if (typeof params.narration === "string" && params.narration.trim().length > 0) {
    body.narration = params.narration.trim().slice(0, 1000);
  }
  if (typeof params.topic === "string" && params.topic.trim().length > 0) {
    body.topic = params.topic.trim().slice(0, 500);
  }
  if (typeof params.userHint === "string" && params.userHint.trim().length > 0) {
    body.userHint = params.userHint.trim().slice(0, 500);
  }
  if (typeof params.stylePreset === "string" && params.stylePreset.trim().length > 0) {
    body.stylePreset = params.stylePreset.trim().slice(0, 100);
  }
  if (typeof params.tone === "string" && params.tone.trim().length > 0) {
    body.tone = params.tone.trim().slice(0, 100);
  }
  if (typeof params.aspect === "string" && params.aspect.length > 0) {
    body.aspect = params.aspect;
  }
  if (typeof params.model === "string" && params.model.trim().length > 0) {
    body.model = params.model.trim();
  }

  let response: Response;
  try {
    response = await fetch(REWRITE_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: params.signal,
    });
  } catch {
    throw new Error(networkErrorMessage());
  }

  if (!response.ok) {
    throw new Error(statusToUserMessage(response.status, await readErrorDetail(response)));
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const fresh =
    typeof payload.imagePrompt === "string"
      ? payload.imagePrompt.trim()
      : typeof payload.image_prompt === "string"
        ? (payload.image_prompt as string).trim()
        : "";
  if (fresh.length === 0) {
    throw new Error("Backend returned an empty image prompt. Please retry.");
  }
  const idx =
    typeof payload.idx === "number" && Number.isInteger(payload.idx)
      ? (payload.idx as number)
      : params.idx;
  return { idx, imagePrompt: fresh };
}
