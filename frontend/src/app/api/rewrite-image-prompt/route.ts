/**
 * Agent 1 — POST /api/rewrite-image-prompt
 *
 * Rewrites ONE scene's text-to-image prompt for FLUX. Other scenes are
 * never touched (no DB write in v1 — the client persists via the
 * existing scenes flow, so `persisted` is always false here).
 *
 * Mirrors the regenerate-scene pattern: Bearer header → body `key` →
 * OPENROUTER_API_KEY env; friendly 401/429/502 mapping; plain-text
 * output (caller renders as text, XSS-safe).
 */

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // per-request Authorization header

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "openai/gpt-4o-mini";
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

// Model may wrap JSON in fences or extra prose — extract the object first.
function parseImagePromptJson(content: string): string {
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
    throw new Error("Model returned an empty image prompt. Please retry.");
  }
  const row = decoded as Record<string, unknown>;
  const prompt = stripHtml(row.imagePrompt ?? row.image_prompt);
  if (prompt.length === 0) {
    throw new Error("Model returned an empty image prompt. Please retry.");
  }
  return prompt;
}

function messageContent(choice: unknown): string {
  if (choice === null || typeof choice !== "object") return "";
  const message = (choice as { message?: unknown }).message;
  if (message === null || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  // Some providers return content blocks: [{ type: "text", text: "..." }]
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block !== null && typeof block === "object" && "text" in block
          ? String((block as { text: unknown }).text ?? "")
          : "",
      )
      .join("\n")
      .trim();
  }
  return "";
}

export async function POST(req: Request): Promise<NextResponse> {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ message: "Invalid JSON body." }, { status: 422 });
  }

  const idxRaw = body.idx;
  const idx =
    typeof idxRaw === "number" && Number.isInteger(idxRaw) ? idxRaw : -1;
  if (idx < 0 || idx > 50) {
    return NextResponse.json(
      { message: "Please provide a valid scene index." },
      { status: 422 },
    );
  }

  const currentPrompt =
    typeof body.imagePrompt === "string"
      ? body.imagePrompt.trim()
      : typeof body.image_prompt === "string"
        ? (body.image_prompt as string).trim()
        : "";
  if (currentPrompt.length === 0) {
    return NextResponse.json(
      { message: "Please describe the scene image first." },
      { status: 422 },
    );
  }
  const sourcePrompt = currentPrompt.slice(0, 2048);

  const narration = cleanShort(body.narration, 1000);
  const topic = cleanShort(body.topic, 500);
  const userHint = cleanShort(body.userHint ?? body.user_hint, 500);
  const stylePreset = cleanShort(body.stylePreset ?? body.style_preset, 100);
  const tone = cleanShort(body.tone, 100);
  const aspectRaw = typeof body.aspect === "string" ? body.aspect : "1080x1920";
  const aspect: Aspect = (ASPECTS as readonly string[]).includes(aspectRaw)
    ? (aspectRaw as Aspect)
    : "1080x1920";
  const requestedModel =
    typeof body.model === "string" && body.model.trim().length > 0
      ? body.model.trim()
      : DEFAULT_MODEL;

  const apiKey =
    readBearerKey(req) ??
    (typeof body.key === "string" && body.key.trim().length > 0
      ? body.key.trim()
      : null) ??
    (process.env.OPENROUTER_API_KEY &&
    process.env.OPENROUTER_API_KEY.trim().length > 0
      ? process.env.OPENROUTER_API_KEY.trim()
      : null);
  if (!apiKey) {
    return NextResponse.json(
      {
        message:
          "No OpenRouter API key provided. Set one in Settings and try again.",
      },
      { status: 422 },
    );
  }

  const orientation =
    aspect === "1920x1080"
      ? "horizontal wide 16:9 cinematic framing (1920x1080)"
      : "vertical 9:16 cinematic framing (1080x1920, Reels/TikTok/Shorts)";
  let systemPrompt =
    "You rewrite ONE text-to-image prompt for FLUX. " +
    "Return JSON only: { \"imagePrompt\": \"enriched detailed visual prompt\" }. " +
    "No markdown, no commentary. " +
    "Keep same subject/scene, improve lighting, lens, mood, composition. " +
    `Aspect ${aspect} (${orientation}). ` +
    "Never rewrite narration.";
  if (userHint) systemPrompt += ` Creator request: ${userHint}.`;
  if (stylePreset) systemPrompt += ` Style preset: ${stylePreset}.`;
  if (tone) systemPrompt += ` Tone: ${tone}.`;

  const userContent =
    `Current image prompt: ${sourcePrompt}` +
    (narration ? `\nScene narration (context only, do not rewrite): ${narration}` : "") +
    (topic ? `\nVideo topic: ${topic}` : "");

  let rewritten: string;
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
        model: requestedModel,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
        response_format: { type: "json_object" },
      }),
    });
    if (upstream.status === 401) {
      return NextResponse.json(
        {
          message:
            "Invalid OpenRouter API key (401). Update it in Settings (/settings) and try again.",
        },
        { status: 401 },
      );
    }
    if (upstream.status === 429) {
      return NextResponse.json(
        {
          message:
            "OpenRouter is busy (429). Retrying automatically in 30s — nothing to re-enter.",
        },
        { status: 429 },
      );
    }
    if (!upstream.ok) {
      return NextResponse.json(
        {
          message: `Image prompt rewrite failed (status ${upstream.status}). Please retry.`,
        },
        { status: 502 },
      );
    }
    const payload = (await upstream.json()) as {
      choices?: unknown[];
    };
    const content = messageContent(payload.choices?.[0]);
    if (content.trim().length === 0) {
      throw new Error("Model returned an empty image prompt. Please retry.");
    }
    rewritten = parseImagePromptJson(content);
  } catch (err) {
    const message =
      err instanceof Error && err.message.trim().length > 0
        ? err.message
        : "Image prompt rewrite failed. Please retry.";
    const status = /401/.test(message) ? 401 : /429|busy/i.test(message) ? 429 : 502;
    return NextResponse.json({ message }, { status });
  }

  return NextResponse.json({ idx, imagePrompt: rewritten, persisted: false });
}
