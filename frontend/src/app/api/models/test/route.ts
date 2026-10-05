/**
 * Agent 1 — Vercel-native replacement for Laravel `POST /api/models/test`
 * (SettingsController@test + OpenRouterService::testKey).
 *
 * - Validates a user-supplied key with a tiny chat completion probe.
 * - Key resolution: `Authorization: Bearer <key>` header first, then body
 *   `key`. Never in URLs, never logged (only a ****last4-style outcome is
 *   returned — not even the mask leaves this route; just ok/message).
 * - Always 200 with `{ ok, message }` (except 422 validation) so the
 *   Settings UI can show the result inline — same contract as Laravel.
 *
 * NOTE: `openai/gpt-4o-mini` below is the cheap test probe (same as the old
 * backend), NOT a hardcoded model list. The model list itself is always live
 * via `../route.ts` (GET /api/models).
 */

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // per-request key in header/body

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
// Cheap probe model for key validation only (mirrors old backend testKey).
const TEST_MODEL = "openai/gpt-4o-mini";

function siteReferer(): string {
  const publicSite = process.env.NEXT_PUBLIC_SITE_URL;
  if (publicSite && publicSite.trim().length > 0) return publicSite.trim();
  const vercelUrl = process.env.VERCEL_URL;
  if (vercelUrl && vercelUrl.trim().length > 0) return `https://${vercelUrl}`;
  return "https://vidiomaker.app";
}

function readBearerKey(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (header) {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match && match[1].trim().length > 0) return match[1].trim();
  }
  return null;
}

export async function POST(req: Request): Promise<NextResponse> {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  const candidate =
    readBearerKey(req) ??
    (typeof body.key === "string" ? body.key.trim() : "");

  if (candidate.length < 8) {
    return NextResponse.json(
      { ok: false, message: "A valid API key is required." },
      { status: 422 },
    );
  }

  try {
    const upstream = await fetch(OPENROUTER_CHAT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${candidate}`,
        "HTTP-Referer": siteReferer(),
        "X-Title": "Vidiomaker",
      },
      body: JSON.stringify({
        model: TEST_MODEL,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 5,
      }),
    });

    if (upstream.status === 401) {
      return NextResponse.json({
        ok: false,
        message: "Invalid API key (401). Update it in Settings (/settings) and test again.",
      });
    }
    if (!upstream.ok) {
      return NextResponse.json({
        ok: false,
        message: `Key test failed (status ${upstream.status}).`,
      });
    }
    return NextResponse.json({ ok: true, message: "API key is valid." });
  } catch (err) {
    const detail = err instanceof Error && err.message ? `: ${err.message}` : ".";
    return NextResponse.json({ ok: false, message: `Key test failed${detail}` });
  }
}
