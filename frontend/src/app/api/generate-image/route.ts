/**
 * Vidiomaker — same-origin Cloudflare Workers AI image proxy.
 *
 * Why a proxy: Workers AI needs `CLOUDFLARE_ACCOUNT_ID` +
 * `CLOUDFLARE_API_TOKEN`, which must NEVER ship to the browser.
 * The frontend (`lib/cloudflare.ts`) POSTs here; this route calls
 * `POST https://api.cloudflare.com/client/v4/accounts/{id}/ai/run/{model}`
 * server-side and streams the image bytes back.
 *
 * - POST { prompt, model?, seed?, width?, height?, steps?, negative_prompt? }
 *   → image/* bytes (content-type preserved from Cloudflare).
 * - GET → { configured, models[] } status for the Settings page (no secrets).
 *
 * Model allowlist: the 4 selectable FLUX ids only (exact Workers AI ids).
 */

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ALLOWED_MODELS = [
  "@cf/black-forest-labs/flux-1-schnell",
  "@cf/black-forest-labs/flux-2-klein-4b",
  "@cf/black-forest-labs/flux-2-klein-9b",
  "@cf/black-forest-labs/flux-2-dev",
] as const;

type AllowedModel = (typeof ALLOWED_MODELS)[number];

const DEFAULT_MODEL: AllowedModel = "@cf/black-forest-labs/flux-1-schnell";

const MIN_STEPS = 1;
const MAX_STEPS = 8;
const DEFAULT_STEPS = 4;

const MAX_PROMPT_LENGTH = 2048;
const MIN_DIM = 256;
const MAX_DIM = 2048;

function configured(): boolean {
  const accountId = (process.env.CLOUDFLARE_ACCOUNT_ID ?? "").trim();
  const token = (process.env.CLOUDFLARE_API_TOKEN ?? "").trim();
  return accountId.length > 0 && token.length > 0;
}

function clampDim(value: unknown, fallback: number): number {
  const num =
    typeof value === "number" && Number.isFinite(value)
      ? Math.round(value)
      : fallback;
  return Math.min(MAX_DIM, Math.max(MIN_DIM, num));
}

function clampSeed(value: unknown): number {
  const num =
    typeof value === "number" && Number.isFinite(value)
      ? Math.floor(value)
      : Math.floor(1 + Math.random() * 999999);
  return Math.min(999999999, Math.max(1, num));
}

function normalizeModel(value: unknown): AllowedModel {
  if (typeof value === "string") {
    const clean = value.trim();
    if ((ALLOWED_MODELS as readonly string[]).includes(clean)) {
      return clean as AllowedModel;
    }
  }
  return DEFAULT_MODEL;
}

function missingConfigResponse(): NextResponse {
  return NextResponse.json(
    {
      message:
        "Cloudflare is not configured. Add CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN to frontend/.env.local (server-only, never NEXT_PUBLIC_), then restart. Get them at dash.cloudflare.com → Workers AI → Use REST API → Create a Workers AI API Token.",
    },
    { status: 422 }
  );
}

/** Status probe for Settings (never leaks secrets). */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    configured: configured(),
    models: [...ALLOWED_MODELS],
    defaultModel: DEFAULT_MODEL,
    defaultSteps: DEFAULT_STEPS,
    minSteps: MIN_STEPS,
    maxSteps: MAX_STEPS,
  });
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = Buffer.from(base64, "base64");
  return new Uint8Array(binary);
}

async function cloudflareToImageResponse(
  upstream: Response
): Promise<NextResponse> {
  const contentType = upstream.headers.get("content-type") ?? "";

  // Case 1: Cloudflare returned raw image bytes (typical REST behavior).
  if (contentType.startsWith("image/")) {
    const bytes = await upstream.arrayBuffer();
    if (bytes.byteLength === 0) {
      return NextResponse.json(
        { message: "Cloudflare returned an empty image. Please retry." },
        { status: 502 }
      );
    }
    return new NextResponse(bytes, {
      status: 200,
      headers: {
        "Content-Type": contentType.split(";")[0],
        "Cache-Control": "no-store",
      },
    });
  }

  // Case 2: JSON envelope with base64 — { result: { image: "<base64>" } }.
  const text = await upstream.text();
  let payload: unknown = null;
  try {
    payload = JSON.parse(text);
  } catch {
    return NextResponse.json(
      { message: `Cloudflare returned an unexpected response (${upstream.status}). Please retry.` },
      { status: 502 }
    );
  }
  const image =
    payload !== null && typeof payload === "object" && "result" in payload
      ? (payload as { result?: unknown }).result
      : null;
  const base64 =
    image !== null && typeof image === "object" && "image" in image
      ? (image as { image?: unknown }).image
      : null;
  if (typeof base64 !== "string" || base64.length === 0) {
    // Surface Cloudflare's own error shape when present.
    const errors =
      payload !== null && typeof payload === "object" && "errors" in payload
        ? (payload as { errors?: unknown }).errors
        : null;
    const first =
      Array.isArray(errors) && errors.length > 0
        ? String(
            (errors[0] as { message?: unknown })?.message ?? errors[0] ?? ""
          )
        : "";
    return NextResponse.json(
      {
        message:
          first ||
          `Cloudflare could not render this prompt (${upstream.status}). Try simplifying the prompt.`,
      },
      { status: 502 }
    );
  }
  const bytes = base64ToBytes(base64);
  // NextResponse expects BodyInit — copy into a fresh ArrayBuffer (avoids
  // the Uint8Array vs BodyInit type mismatch, byteOffset-safe).
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new NextResponse(body, {
    status: 200,
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store" },
  });
}

export async function POST(req: Request): Promise<NextResponse> {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { message: "Invalid JSON body. Send { prompt, model, seed, width, height }." },
      { status: 422 }
    );
  }

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (prompt.length === 0) {
    return NextResponse.json(
      { message: "Please describe the scene image first." },
      { status: 422 }
    );
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return NextResponse.json(
      { message: "Image prompt is too long (max 2048 characters)." },
      { status: 422 }
    );
  }

  const model = normalizeModel(body.model);
  const seed = clampSeed(body.seed);
  const width = clampDim(body.width ?? body.w ?? 1080, 1080);
  const height = clampDim(body.height ?? body.h ?? 1920, 1920);
  // NOTE: negative_prompt is accepted by the request shape but ignored —
  // no current FLUX model takes it (schnell rejects extra props, FLUX.2
  // multipart params are prompt/width/height/seed[/steps for dev]).
  const stepsRaw =
    typeof body.steps === "number" && Number.isFinite(body.steps)
      ? Math.round(body.steps)
      : null;
  const steps =
    stepsRaw === null ? null : Math.min(MAX_STEPS, Math.max(MIN_STEPS, stepsRaw));

  if (!configured()) {
    return missingConfigResponse();
  }
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID!.trim();
  const token = process.env.CLOUDFLARE_API_TOKEN!.trim();
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;

  // flux-1-schnell takes JSON with prompt (+steps) ONLY — the live
  // schema is { prompt, steps? } with additionalProperties:false, so
  // seed/width/height/negative_prompt all 400. (Seed badges in the UI
  // stay display-only for schnell; klein/dev keep real seeds.)
  // The three FLUX.2 models take multipart/form-data even for
  // prompt-only (JSON → 400 "required properties 'multipart'").
  const isSchnell = model === "@cf/black-forest-labs/flux-1-schnell";
  const isDev = model === "@cf/black-forest-labs/flux-2-dev";

  async function callCloudflareJson(
    payload: Record<string, unknown>
  ): Promise<Response> {
    return fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  }

  function buildMultipart(
    opts: { minimal?: boolean } = {}
  ): FormData {
    const form = new FormData();
    form.append("prompt", prompt);
    if (!opts.minimal) {
      // klein/dev accept seed + dimensions (verified live 2026-10-01).
      // klein steps are fixed at 4 (must NOT send); dev accepts steps.
      form.append("width", String(width));
      form.append("height", String(height));
      form.append("seed", String(seed));
      if (isDev && steps !== null) form.append("steps", String(steps));
    } else {
      form.append("width", String(width));
      form.append("height", String(height));
    }
    return form;
  }

  async function callCloudflareMultipart(form: FormData): Promise<Response> {
    // fetch sets the multipart boundary automatically — do NOT set
    // Content-Type manually or Cloudflare cannot parse the fields.
    return fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
  }

  /** Pull Cloudflare's own { errors: [{ message }] } text for the UI. */
  async function readUpstreamDetail(res: Response): Promise<string> {
    try {
      const text = await res.clone().text();
      const payload = JSON.parse(text) as {
        errors?: Array<{ message?: unknown }>;
      };
      const first = Array.isArray(payload.errors)
        ? payload.errors[0]?.message
        : null;
      return typeof first === "string" ? first.slice(0, 300) : "";
    } catch {
      return "";
    }
  }

  let upstream: Response;
  try {
    if (isSchnell) {
      const jsonBody: Record<string, unknown> = {
        prompt,
        ...(steps !== null ? { steps } : {}),
      };
      upstream = await callCloudflareJson(jsonBody);
      // Retry once with the bare-minimum shape when rejected
      // (e.g. unknown param for a model variant) — not for auth/rate.
      if (upstream.status === 400) {
        upstream = await callCloudflareJson({ prompt });
        if (!upstream.ok) {
          const detail = await readUpstreamDetail(upstream);
          return NextResponse.json(
            {
              message:
                `Cloudflare could not render this prompt (${upstream.status}). Try simplifying the prompt.` +
                (detail ? ` (${detail})` : ""),
            },
            { status: 502 }
          );
        }
      }
    } else {
      upstream = await callCloudflareMultipart(buildMultipart());
      // Retry once with prompt+dimensions only (no seed/steps).
      if (upstream.status === 400) {
        upstream = await callCloudflareMultipart(
          buildMultipart({ minimal: true })
        );
        if (!upstream.ok) {
          const detail = await readUpstreamDetail(upstream);
          return NextResponse.json(
            {
              message:
                `Cloudflare could not render this prompt (${upstream.status}). Try simplifying the prompt.` +
                (detail ? ` (${detail})` : ""),
            },
            { status: 502 }
          );
        }
      }
    }
  } catch {
    return NextResponse.json(
      { message: "Could not reach Cloudflare. Check your connection, then retry." },
      { status: 502 }
    );
  }

  if (upstream.status === 401 || upstream.status === 403) {
    return NextResponse.json(
      {
        message:
          "Cloudflare credentials invalid (401/403). Check CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN in frontend/.env.local (token needs Workers AI Read + Edit), then restart.",
      },
      { status: 502 }
    );
  }
  if (upstream.status === 429) {
    return NextResponse.json(
      {
        message:
          "Cloudflare is busy (429). Retrying automatically — no need to re-enter anything.",
      },
      { status: 429 }
    );
  }
  if (!upstream.ok) {
    return NextResponse.json(
      {
        message: `Cloudflare could not render this prompt (${upstream.status}). Try simplifying the prompt.`,
      },
      { status: 502 }
    );
  }

  try {
    return await cloudflareToImageResponse(upstream);
  } catch {
    return NextResponse.json(
      { message: "Cloudflare returned an unreadable image. Please retry." },
      { status: 502 }
    );
  }
}
