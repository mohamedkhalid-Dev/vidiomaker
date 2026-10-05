/**
 * Agent 1 — Vercel-native replacement for Laravel `POST /api/regenerate-scene`
 * (ScriptController@regenerate + OpenRouterService::regenerateScene).
 *
 * - Regenerates ONE scene (idx) only; other scenes are never touched.
 * - Context resolution: explicit body `topic`/`model` win; when `video_id`
 *   is given AND Supabase service-role env is configured, the video row
 *   (topic/model_id) + scene row (duration) fill in missing values and the
 *   fresh scene is written back to that row (image_url reset to null, like
 *   the Laravel version). Without DB access it is a pure function:
 *   topic/model/duration come from the body and only the patch is returned.
 * - Key resolution: Bearer header → body `key` → `OPENROUTER_API_KEY` env.
 *   Never in URLs, never logged.
 * - Response shape matches what `lib/api.ts regenerateScriptScene` parses:
 *   flat scene fields (accepts `{ scene: {...} }` or flat) with BOTH
 *   `imagePrompt` and `image_prompt` keys.
 */

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // per-request Authorization header

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const ASPECTS = ["1080x1920", "1920x1080"] as const;
type Aspect = (typeof ASPECTS)[number];

function siteReferer(): string {
  const publicSite = process.env.NEXT_PUBLIC_SITE_URL;
  if (publicSite && publicSite.trim().length > 0) return publicSite.trim();
  const vercelUrl = process.env.VERCEL_URL;
  if (vercelUrl && vercelUrl.trim().length > 0) return `https://${vercelUrl}`;
  return "https://vidiomaker.app";
}

function stripHtml(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/<[^>]*>/g, "").trim();
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, num));
}

function cleanShort(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, max);
}

function readBearerKey(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (header) {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match && match[1].trim().length > 0) return match[1].trim();
  }
  return null;
}

function parseSceneJson(content: string, fallbackDuration: number): { narration: string; imagePrompt: string; duration: number } {
  let clean = content.trim();
  if (clean.startsWith("```")) {
    clean = clean.replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, "");
  }
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    clean = clean.slice(start, end + 1);
  }
  let decoded: unknown = null;
  try {
    decoded = JSON.parse(clean);
  } catch {
    decoded = null;
  }
  if (decoded === null || typeof decoded !== "object") {
    throw new Error("Model returned invalid scene JSON. Please retry.");
  }
  let row = decoded as Record<string, unknown>;
  // Accept a full-script wrapper — use its first scene (mirrors Laravel parser).
  if (Array.isArray(row.scenes) && row.scenes.length > 0 && typeof row.scenes[0] === "object" && row.scenes[0] !== null) {
    row = row.scenes[0] as Record<string, unknown>;
  }
  const narration = stripHtml(row.narration);
  const imagePrompt = stripHtml(row.imagePrompt ?? row.image_prompt);
  const durationRaw = typeof row.duration === "number" && Number.isFinite(row.duration) ? row.duration : fallbackDuration;
  const duration = Math.min(30, Math.max(1, Math.round(durationRaw)));
  if (narration === "" && imagePrompt === "") {
    throw new Error("Model returned invalid scene JSON. Please retry.");
  }
  return { narration, imagePrompt, duration };
}

export async function POST(req: Request): Promise<NextResponse> {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ message: "Invalid JSON body." }, { status: 422 });
  }

  const idxRaw = body.idx;
  const idx = typeof idxRaw === "number" && Number.isInteger(idxRaw) ? idxRaw : -1;
  if (idx < 0 || idx > 50) {
    return NextResponse.json(
      { message: "Please provide a valid video and scene index." },
      { status: 422 },
    );
  }

  const videoId =
    typeof body.video_id === "string" && body.video_id.length > 0
      ? body.video_id
      : typeof body.videoId === "string" && body.videoId.length > 0
        ? body.videoId
        : null;

  const apiKey =
    readBearerKey(req) ??
    (typeof body.key === "string" && body.key.trim().length > 0 ? body.key.trim() : null) ??
    (process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_API_KEY.trim().length > 0
      ? process.env.OPENROUTER_API_KEY.trim()
      : null);
  if (!apiKey) {
    return NextResponse.json(
      { message: "No OpenRouter API key provided. Set one in Settings and try again." },
      { status: 422 },
    );
  }

  // Context: body first, Supabase video/scene rows as fallback (service-role only).
  let topic = typeof body.topic === "string" ? body.topic.trim() : "";
  let model = typeof body.model === "string" ? body.model.trim() : "";
  let duration = clampInt(body.duration ?? 5, 3, 6, 5);
  let totalScenes = 1;
  const aspectRaw = typeof body.aspect === "string" ? body.aspect : "1080x1920";
  const aspect: Aspect = (ASPECTS as readonly string[]).includes(aspectRaw) ? (aspectRaw as Aspect) : "1080x1920";
  const negativePrompt = cleanShort(body.negativePrompt ?? body.negative_prompt ?? null, 500);
  const customInstructions = cleanShort(body.customInstructions ?? body.custom_instructions ?? null, 500);
  const stylePreset = cleanShort(body.stylePreset ?? body.style_preset ?? null, 100);
  const tone = cleanShort(body.tone ?? null, 100);
  const language = cleanShort(body.language ?? null, 100);
  const targetAudience = cleanShort(body.targetAudience ?? body.target_audience ?? null, 100);

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const dbConfigured = supabaseUrl.trim().length > 0 && serviceRoleKey.trim().length > 0;

  if (videoId && dbConfigured && (topic === "" || model === "")) {
    try {
      const admin = createClient(supabaseUrl, serviceRoleKey);
      const { data: video } = await admin.from("videos").select("topic,model_id").eq("id", videoId).maybeSingle();
      if (video) {
        if (topic === "" && typeof video.topic === "string") topic = video.topic;
        if (model === "" && typeof video.model_id === "string") model = video.model_id;
      }
      const { data: scene } = await admin
        .from("scenes")
        .select("duration")
        .eq("video_id", videoId)
        .eq("idx", idx)
        .maybeSingle();
      if (scene && typeof scene.duration === "number") {
        duration = clampInt(scene.duration, 3, 6, duration);
      }
      const { count } = await admin.from("scenes").select("id", { count: "exact", head: true }).eq("video_id", videoId);
      if (typeof count === "number" && count > 0) totalScenes = count;
    } catch {
      // DB context is best-effort; body values still apply below.
    }
  }

  if (topic === "" || model === "") {
    return NextResponse.json(
      { message: "Video has no topic/model to regenerate from." },
      { status: 422 },
    );
  }

  const orientation =
    aspect === "1920x1080"
      ? "horizontal wide 16:9 cinematic framing (1920x1080)"
      : "vertical 9:16 cinematic framing (1080x1920, Reels/TikTok/Shorts)";
  const systemPrompt =
    "You regenerate ONE video scene. " +
    'Return JSON only: { "narration": "...", "imagePrompt": "detailed visual prompt, vertical cinematic...", "duration": 5 }. ' +
    "No markdown, no code fences, no commentary. " +
    `This is scene index ${idx} of ${Math.max(totalScenes, 1)} (0-based) — keep continuity with the same story. ` +
    `Duration must be ${duration} seconds. Aspect ${aspect} (${orientation}). ` +
    "imagePrompt must be detailed with vertical cinematic hints (lighting, lens, mood, composition). " +
    (negativePrompt ? `Avoid (negative prompt): ${negativePrompt}. ` : "") +
    (customInstructions ? `Creator instructions: ${customInstructions}. ` : "") +
    (stylePreset ? `Style preset: ${stylePreset}. ` : "") +
    (tone ? `Tone: ${tone}. ` : "") +
    (language ? `Write narration in ${language}. ` : "") +
    (targetAudience ? `Target audience: ${targetAudience}. ` : "");

  let fresh: { narration: string; imagePrompt: string; duration: number };
  try {
    const upstream = await fetch(OPENROUTER_CHAT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": siteReferer(),
        "X-Title": "Vidiomaker",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Video topic: ${topic}` },
        ],
        response_format: { type: "json_object" },
      }),
    });
    if (upstream.status === 401) {
      return NextResponse.json(
        { message: "Invalid OpenRouter API key (401). Update it in Settings (/settings) and try again." },
        { status: 401 },
      );
    }
    if (upstream.status === 429) {
      return NextResponse.json(
        { message: "OpenRouter is busy (429). Retrying automatically in 30s — nothing to re-enter." },
        { status: 429 },
      );
    }
    if (!upstream.ok) {
      return NextResponse.json(
        { message: `Scene regeneration failed (status ${upstream.status}). Please retry.` },
        { status: 502 },
      );
    }
    const payload = (await upstream.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    fresh = parseSceneJson(typeof content === "string" ? content : "", duration);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Scene regeneration failed. Please retry.";
    const status = /401/.test(message) ? 401 : /429|busy/i.test(message) ? 429 : 502;
    return NextResponse.json({ message }, { status });
  }

  const narration = stripHtml(fresh.narration);
  const imagePrompt = stripHtml(fresh.imagePrompt);
  const sceneDuration = Math.min(30, Math.max(1, fresh.duration));
  const seed = Math.floor(1 + Math.random() * 999999999);

  // Write back to the single scenes row when possible (image_url reset forces
  // Stage 4 to refetch, like the Laravel version). Best-effort only.
  let persisted = false;
  if (videoId && dbConfigured) {
    try {
      const admin = createClient(supabaseUrl, serviceRoleKey);
      const { error } = await admin
        .from("scenes")
        .update({
          narration,
          image_prompt: imagePrompt,
          seed,
          image_url: null,
          duration: sceneDuration,
        })
        .eq("video_id", videoId)
        .eq("idx", idx);
      persisted = !error;
    } catch {
      persisted = false;
    }
  }

  return NextResponse.json({
    video_id: videoId,
    idx,
    narration,
    imagePrompt,
    image_prompt: imagePrompt,
    seed,
    duration: sceneDuration,
    image_url: null,
    persisted,
  });
}
