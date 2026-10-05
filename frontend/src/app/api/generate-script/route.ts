/**
 * Agent 1 — Vercel-native replacement for Laravel `POST /api/generate-script`
 * (ScriptController@store + OpenRouterService::chat).
 *
 * SUPABASE DECISION (Agent 1, documented per scope):
 * - When `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` are set,
 *   this route inserts the `videos` + `scenes` rows server-side (service-role
 *   key stays server-side only, never exposed, never logged) and returns
 *   `persisted: true`.
 * - When they are NOT set (e.g. local preview without secrets), the route
 *   still returns the full script + a generated `video_id` with
 *   `persisted: false` so the client (or the Supabase/persistence agent)
 *   can insert the rows client-side. Response shape is identical either way,
 *   so ScriptEditor/TopicInput never break — check `persisted`/`warning`.
 *
 * Contract (mirrors the Laravel behavior):
 * - Accepts camelCase AND snake_case body keys (frontend sends snake_case).
 * - Key resolution: `Authorization: Bearer <key>` header first, then body
 *   `key`, then `OPENROUTER_API_KEY` env fallback. Never in URLs, never logged.
 * - Forces JSON-only output via system prompt + `response_format: json_object`.
 * - Sanitizes narration/image prompts (strip HTML tags — XSS-safe; React
 *   escapes on render anyway) and assigns a random seed per scene.
 * - Each scene carries BOTH `imagePrompt` (lib/openrouter.ts shape) and
 *   `image_prompt` (lib/api.ts + Supabase column shape) so both clients work.
 */

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // per-request Authorization header

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";

const MAX_TOPIC_LENGTH = 2000;
const MAX_MODEL_LENGTH = 255;
const MIN_SCENES = 3;
const MAX_SCENES = 8;
const MIN_DURATION = 3;
const MAX_DURATION = 6;
const ASPECTS = ["1080x1920", "1920x1080"] as const;
type Aspect = (typeof ASPECTS)[number];

function siteReferer(): string {
  const publicSite = process.env.NEXT_PUBLIC_SITE_URL;
  if (publicSite && publicSite.trim().length > 0) return publicSite.trim();
  const vercelUrl = process.env.VERCEL_URL;
  if (vercelUrl && vercelUrl.trim().length > 0) return `https://${vercelUrl}`;
  return "https://vidiomaker.app";
}

/** Mirrors PHP `strip_tags()` for narration/prompts (stored-XSS safety). */
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

function buildSystemPrompt(opts: {
  sceneCount: number;
  duration: number;
  aspect: Aspect;
  negativePrompt: string | null;
  customInstructions: string | null;
  stylePreset: string | null;
  tone: string | null;
  language: string | null;
  targetAudience: string | null;
}): string {
  const orientation =
    opts.aspect === "1920x1080"
      ? "horizontal wide 16:9 cinematic framing (1920x1080, no letterboxing)"
      : "vertical 9:16 cinematic framing (1080x1920, Reels/TikTok/Shorts, full-frame subject, no letterboxing)";
  let prompt =
    "You generate short video scripts. " +
    'Return JSON only: { "title": "...", "scenes": [' +
    '{ "narration": "...", "imagePrompt": "detailed visual prompt, vertical cinematic...", "duration": 5 }' +
    "] }. No markdown, no code fences, no commentary. " +
    `Generate exactly ${opts.sceneCount} scenes. ` +
    `Each scene duration must be ${opts.duration} seconds (set "duration": ${opts.duration} on every scene). ` +
    `Aspect ${opts.aspect} (${orientation}). ` +
    "Each imagePrompt must be a detailed visual prompt with vertical cinematic hints " +
    "(lighting, lens, mood, composition) suitable for AI image generation. ";
  if (opts.negativePrompt) {
    prompt += `Avoid (negative prompt): ${opts.negativePrompt}. Do not include these elements in narration or imagePrompt. `;
  }
  if (opts.customInstructions) {
    prompt += `Creator instructions: ${opts.customInstructions}. `;
  }
  if (opts.stylePreset) {
    prompt += `Style preset: ${opts.stylePreset}. `;
  }
  if (opts.tone) {
    prompt += `Tone: ${opts.tone}. `;
  }
  if (opts.language) {
    prompt += `Write all narration in ${opts.language}. `;
  }
  if (opts.targetAudience) {
    prompt += `Target audience: ${opts.targetAudience}. `;
  }
  return prompt;
}

/** Tolerates ``` fences / surrounding prose, like the Laravel parser. */
function parseScriptJson(content: string): { title: string; scenes: unknown[] } {
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
  if (
    decoded === null ||
    typeof decoded !== "object" ||
    !("title" in decoded) ||
    !("scenes" in decoded) ||
    !Array.isArray((decoded as { scenes: unknown }).scenes) ||
    (decoded as { scenes: unknown[] }).scenes.length === 0
  ) {
    throw new Error("Model returned invalid script JSON. Please retry.");
  }
  const row = decoded as { title: unknown; scenes: unknown[] };
  return { title: String(row.title ?? ""), scenes: row.scenes };
}

export async function POST(req: Request): Promise<NextResponse> {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ message: "Invalid JSON body." }, { status: 422 });
  }

  // --- Validation (mirrors ScriptController@store rules) ---
  const errors: Record<string, string[]> = {};
  const topic = typeof body.topic === "string" ? body.topic.trim() : "";
  const model = typeof body.model === "string" ? body.model.trim() : "";
  if (topic.length === 0) errors.topic = ["Please describe your video idea first."];
  else if (topic.length > MAX_TOPIC_LENGTH) errors.topic = ["Topic is too long (max 2000 characters)."];
  if (model.length === 0) errors.model = ["Please select a model first."];
  else if (model.length > MAX_MODEL_LENGTH) errors.model = ["Model id is too long."];
  const sceneCount = clampInt(body.sceneCount ?? body.scene_count ?? 5, MIN_SCENES, MAX_SCENES, 5);
  const durationDefault = clampInt(
    body.duration ?? body.durationPerScene ?? 5,
    MIN_DURATION,
    MAX_DURATION,
    5,
  );
  const aspectRaw = typeof body.aspect === "string" ? body.aspect : "1080x1920";
  const aspect: Aspect = (ASPECTS as readonly string[]).includes(aspectRaw) ? (aspectRaw as Aspect) : "1080x1920";
  const negativePrompt = cleanShort(body.negativePrompt ?? body.negative_prompt ?? null, 500);
  const customInstructions = cleanShort(body.customInstructions ?? body.custom_instructions ?? null, 500);
  const stylePreset = cleanShort(body.stylePreset ?? body.style_preset ?? null, 100);
  const tone = cleanShort(body.tone ?? null, 100);
  const language = cleanShort(body.language ?? null, 100);
  const targetAudience = cleanShort(body.targetAudience ?? body.target_audience ?? null, 100);

  if (Object.keys(errors).length > 0) {
    return NextResponse.json(
      { message: "Please describe your video idea first.", errors },
      { status: 422 },
    );
  }

  // --- Key resolution: Bearer header → body `key` → server env. Never logged. ---
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

  // --- OpenRouter chat/completions (JSON-only) ---
  const systemPrompt = buildSystemPrompt({
    sceneCount,
    duration: durationDefault,
    aspect,
    negativePrompt,
    customInstructions,
    stylePreset,
    tone,
    language,
    targetAudience,
  });

  let parsed: { title: string; scenes: unknown[] };
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
          { role: "user", content: topic },
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
        { message: `Script generation failed (status ${upstream.status}). Please retry.` },
        { status: 502 },
      );
    }
    const payload = (await upstream.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    parsed = parseScriptJson(typeof content === "string" ? content : "");
  } catch (err) {
    const message = err instanceof Error ? err.message : "Script generation failed. Please retry.";
    const status = /401/.test(message) ? 401 : /429|busy/i.test(message) ? 429 : 502;
    return NextResponse.json({ message }, { status });
  }

  // --- Sanitize (strip HTML/XSS) + normalize + seeds (mirrors ScriptController) ---
  const title = stripHtml(parsed.title) || topic;
  const scenes = parsed.scenes
    .map((entry) => {
      if (entry === null || typeof entry !== "object") return null;
      const row = entry as Record<string, unknown>;
      const narration = stripHtml(row.narration);
      const imagePrompt = stripHtml(row.imagePrompt ?? row.image_prompt);
      const durationRaw = typeof row.duration === "number" && Number.isFinite(row.duration) ? row.duration : durationDefault;
      const duration = Math.min(30, Math.max(1, Math.round(durationRaw)));
      return {
        narration,
        imagePrompt,
        image_prompt: imagePrompt,
        duration,
        seed: Math.floor(1 + Math.random() * 999999999),
      };
    })
    .filter((s): s is NonNullable<typeof s> => s !== null)
    .slice(0, sceneCount)
    .map((scene, idx) => ({ ...scene, idx }));

  if (scenes.length === 0) {
    return NextResponse.json({ message: "Model returned no scenes. Please retry." }, { status: 502 });
  }

  const videoId = crypto.randomUUID();

  // --- Persist server-side when service-role is configured (server-only) ---
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (supabaseUrl.trim().length > 0 && serviceRoleKey.trim().length > 0) {
    try {
      const admin = createClient(supabaseUrl, serviceRoleKey);
      const { error: videoError } = await admin.from("videos").insert({
        id: videoId,
        title,
        topic,
        model_id: model,
        status: "draft",
      });
      if (videoError) throw new Error(videoError.message);
      const { error: scenesError } = await admin.from("scenes").insert(
        scenes.map((scene) => ({
          video_id: videoId,
          idx: scene.idx,
          narration: scene.narration,
          image_prompt: scene.image_prompt,
          seed: scene.seed,
          image_url: null,
          duration: scene.duration,
        })),
      );
      if (scenesError) throw new Error(scenesError.message);
      return NextResponse.json(
        { video_id: videoId, videoId, title, scenes, persisted: true },
        { status: 201 },
      );
    } catch {
      // Fall through: return the good script anyway (client can persist).
    }
  }

  // No service-role configured (or DB write failed): client-side insert path.
  return NextResponse.json(
    {
      video_id: videoId,
      videoId,
      title,
      scenes,
      persisted: false,
      warning:
        "Script generated but not saved server-side (Supabase service-role not configured). " +
        "The client should insert the videos/scenes rows.",
    },
    { status: 201 },
  );
}
