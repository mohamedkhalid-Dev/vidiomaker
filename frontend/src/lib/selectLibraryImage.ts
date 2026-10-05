/**
 * Vidiomaker — library-image selector helpers (additive, generation flow untouched).
 *
 * Two ranking tiers:
 *   1. `scoreLibraryImages` — instant client-side keyword match (no network,
 *      always available). Used for live search + pre-sort before any AI call.
 *   2. `aiPickLibraryImageId` — OpenRouter prompt that picks the best
 *      `{id}` from a compact `[{id,description}]` list. The caller supplies
 *      the user's own key + model (same Bearer pattern as lib/openrouter.ts);
 *      no new server route required.
 *
 * Supabase source: `supabase.from("images").select(...)`.
 * NOTE (research finding): `public.images` does NOT exist yet in
 * supabase/schema.sql (only videos/scenes). Run the migration in
 * `supabase/migration_003_images_library.sql` (new file, this change) before
 * the picker can return rows — until then every fetch resolves `[]` and the
 * picker shows its empty state ("No saved images yet — upload one").
 */

import { isSupabaseConfigured, supabase } from "./supabase";

/** One saved library row (mirrors migration_003_images_library.sql). */
export interface LibraryImage {
  id: string;
  description: string;
  url: string;
  createdAt?: string | null;
}

/** Scored wrapper returned by scoreLibraryImages(). */
export interface ScoredLibraryImage extends LibraryImage {
  score: number;
}

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "in", "on", "at", "to", "for",
  "with", "by", "is", "are", "it", "its", "this", "that", "from",
]);

/** Lowercase alphanumeric tokens minus stopwords. Exported for tests. */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (token) => token.length > 1 && !STOPWORDS.has(token),
  );
}

/**
 * Rank library images against a scene/topic query (pure function, no I/O).
 * Score = 3 × full-query substring hit + 2 × per-token hit + 1 × prefix hit.
 * Ties break by newest createdAt, then id. Zero-score items are dropped
 * unless the query is blank (blank = return all, newest first, capped).
 */
export function scoreLibraryImages(
  query: string,
  images: LibraryImage[],
  limit = 24,
): ScoredLibraryImage[] {
  const clean = query.trim().toLowerCase();
  if (clean.length === 0) {
    return [...images]
      .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
      .slice(0, limit)
      .map((img) => ({ ...img, score: 0 }));
  }
  const tokens = tokenize(clean);
  const scored: ScoredLibraryImage[] = [];
  for (const img of images) {
    const hay = img.description.toLowerCase();
    let score = 0;
    if (hay.includes(clean)) score += 3;
    for (const token of tokens) {
      if (hay.includes(token)) score += 2;
      else if (
        hay.split(/[^a-z0-9]+/).some((word) => word.startsWith(token))
      ) {
        score += 1;
      }
    }
    if (score > 0) scored.push({ ...img, score });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (b.createdAt ?? "").localeCompare(a.createdAt ?? "") ||
      a.id.localeCompare(b.id),
  );
  return scored.slice(0, limit);
}

/**
 * Convenience: best single match for a scene (topic or narration+prompt).
 * Returns null when nothing scores — caller falls back to full grid order.
 */
export function selectImageForScene(
  topicOrSceneText: string,
  images: LibraryImage[],
): LibraryImage | null {
  const ranked = scoreLibraryImages(topicOrSceneText, images, 1);
  return ranked.length > 0 ? ranked[0] : null;
}

/** Raw row shape from the `images` table (both naming conventions). */
interface ImagesRow {
  id?: unknown;
  description?: unknown;
  prompt?: unknown;
  image_url?: unknown;
  url?: unknown;
  created_at?: unknown;
}

function toLibraryImage(row: ImagesRow): LibraryImage | null {
  const id = typeof row.id === "string" ? row.id : null;
  const description =
    typeof row.description === "string" && row.description.length > 0
      ? row.description
      : typeof row.prompt === "string"
        ? row.prompt
        : "";
  const url =
    typeof row.image_url === "string" && row.image_url.length > 0
      ? row.image_url
      : typeof row.url === "string"
        ? row.url
        : "";
  if (!id || !url) return null;
  return {
    id,
    description,
    url,
    createdAt: typeof row.created_at === "string" ? row.created_at : null,
  };
}

/**
 * Load the library (newest first). Never throws — missing table / RLS /
 * offline all resolve to `[]` so the picker can render its empty state.
 * Pass `search` for a server-side pre-filter (ilike); client re-ranks after.
 */
export async function fetchLibraryImages(search = ""): Promise<LibraryImage[]> {
  if (!isSupabaseConfigured()) return [];
  try {
    let query = supabase
      .from("images")
      .select("id,description,image_url,created_at")
      .order("created_at", { ascending: false })
      .limit(100);
    const clean = search.trim();
    if (clean.length > 0) {
      // ilike pre-filter; trigram similarity variant (needs pg_trgm):
      //   .or(`description.ilike.%${clean}%,prompt.ilike.%${clean}%`)
      // SQL equivalent for psql / full-text ranking:
      //   select id, description, image_url
      //   from public.images
      //   where description ilike '%query%'
      //   order by similarity(description, 'query') desc limit 24;
      query = query.ilike("description", `%${clean.slice(0, 120)}%`);
    }
    const { data, error } = await query;
    if (error) return [];
    const rows = (Array.isArray(data) ? data : []) as ImagesRow[];
    const items: LibraryImage[] = [];
    for (const row of rows) {
      const item = toLibraryImage(row);
      if (item) items.push(item);
    }
    return items;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Tier 2 — OpenRouter AI pick (optional, per-scene "AI assist").
// ---------------------------------------------------------------------------

export interface AiPickOptions {
  /** User's OpenRouter key (Settings page key; never hardcoded). */
  apiKey: string;
  /** Any chat model the user already picked (default: cheap + fast). */
  model?: string;
  signal?: AbortSignal;
}

const AI_PICK_MODEL_FALLBACK = "openai/gpt-4o-mini";

/**
 * Build the ranking prompt. Exported so the prompt text is reviewable in
 * isolation (and reusable from a future server route without duplication).
 *
 * Contract: model MUST reply with JSON only: { "bestId": "<id>" | null }.
 */
export function buildLibraryRankPrompt(
  sceneText: string,
  candidates: Pick<LibraryImage, "id" | "description">[],
): string {
  const list = candidates
    .slice(0, 30)
    .map((c) => `- id:${c.id} description:${c.description.slice(0, 200)}`)
    .join("\n");
  return (
    `You pick the best saved image for a video scene. Reply with JSON only: {"bestId": "<id>" or null}.\n` +
    `Scene (topic/narration/imagePrompt): ${sceneText.slice(0, 600)}\n` +
    `Candidates:\n${list}\n` +
    `Rules: prefer literal subject + setting overlap; ignore style words unless tied; null when nothing matches.`
  );
}

/**
 * Ask OpenRouter to pick the best candidate id. Direct browser call with the
 * user's own key (same trust model as Settings → Test). Never throws —
 * resolves null on any failure so the UI falls back to keyword ranking.
 */
export async function aiPickLibraryImageId(
  sceneText: string,
  candidates: LibraryImage[],
  options: AiPickOptions,
): Promise<string | null> {
  const cleanKey = options.apiKey.trim();
  const cleanScene = sceneText.trim();
  if (!cleanKey || !cleanScene || candidates.length === 0) return null;
  const model = (options.model ?? "").trim() || AI_PICK_MODEL_FALLBACK;
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cleanKey}`,
        "HTTP-Referer": "https://vidiomaker.app",
        "X-Title": "Vidiomaker",
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: buildLibraryRankPrompt(cleanScene, candidates),
          },
        ],
        response_format: { type: "json_object" },
      }),
      signal: options.signal,
    });
    if (!res.ok) return null;
    const payload = (await res.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const raw = payload.choices?.[0]?.message?.content;
    const text = typeof raw === "string" ? raw : "";
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    const parsed = JSON.parse(text.slice(start, end + 1)) as {
      bestId?: unknown;
    };
    const bestId = typeof parsed.bestId === "string" ? parsed.bestId : null;
    if (!bestId) return null;
    // Guard: model must pick from the offered list (no hallucinations).
    return candidates.some((c) => c.id === bestId) ? bestId : null;
  } catch {
    return null;
  }
}
