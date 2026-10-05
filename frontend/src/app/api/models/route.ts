/**
 * Agent 1 — Vercel-native replacement for Laravel `GET /api/models`
 * (ModelController@index + OpenRouterService::listModels).
 *
 * - GET proxies https://openrouter.ai/api/v1/models with a 1h cache
 *   (`export const revalidate` + `fetch(next: { revalidate: 3600 })`,
 *   mirroring the old `$cacheTtl = 3600`), plus an in-memory fallback to
 *   the last good list when upstream fails.
 * - No API key needed (public endpoint). Never logs keys (none involved).
 * - Response shape matches the old backend: `{ data: [...] }`, with an
 *   optional `warning` when serving a stale cached list.
 *
 * Coordinate: frontend `lib/openrouter.ts` calls this same-origin route
 * first and falls back to OpenRouter directly. Do NOT add a hardcoded
 * model list here — the list is always live (or last-cached).
 */

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const revalidate = 3600; // 1h cache (mirrors OpenRouterService $cacheTtl)

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

// In-memory fallback: last good list for THIS serverless instance when
// upstream fails. (The data cache above covers warm instances; this covers
// cold ones. Never a hardcoded list.)
let lastGoodList: unknown[] | null = null;

function extractList(payload: unknown): unknown[] | null {
  if (Array.isArray(payload)) return payload;
  if (payload !== null && typeof payload === "object" && "data" in payload) {
    const data = (payload as { data: unknown }).data;
    if (Array.isArray(data)) return data;
  }
  return null;
}

export async function GET(): Promise<NextResponse> {
  try {
    const upstream = await fetch(OPENROUTER_MODELS_URL, {
      headers: { Accept: "application/json" },
      next: { revalidate: 3600 },
    });
    if (!upstream.ok) {
      throw new Error(`OpenRouter models request failed (${upstream.status}).`);
    }
    const payload: unknown = await upstream.json();
    const data = extractList(payload);
    if (!data) {
      throw new Error("Model list response had an unexpected shape.");
    }
    lastGoodList = data;
    return NextResponse.json({ data });
  } catch {
    if (lastGoodList !== null) {
      return NextResponse.json({
        data: lastGoodList,
        warning: "Live model list unavailable. Showing cached list.",
      });
    }
    return NextResponse.json(
      {
        data: [],
        message: "Model list unavailable. Please retry.",
      },
      { status: 502 },
    );
  }
}
