/**
 * Vidiomaker shared frontend types (Stage 3).
 * VideoOptions is the single source of truth for topic submission options.
 * TopicInput.tsx re-exports it for convenience.
 */

export type VideoAspect = "1080x1920" | "1920x1080";

export interface VideoOptions {
  sceneCount: number;
  duration: number;
  aspect: VideoAspect;
  negativePrompt?: string;
  customInstructions?: string;
  stylePreset?: string;
  tone?: string;
  language?: string;
  targetAudience?: string;
}

export const DEFAULT_VIDEO_OPTIONS: VideoOptions = {
  sceneCount: 5,
  duration: 5,
  aspect: "1080x1920",
};

export const MIN_SCENE_COUNT = 3;
export const MAX_SCENE_COUNT = 8;
export const MIN_SCENE_DURATION = 3;
export const MAX_SCENE_DURATION = 6;

/** Max free-text creator instructions (UI counter + backend trims to this). */
export const MAX_CUSTOM_INSTRUCTIONS_LENGTH = 500;

export const STYLE_PRESETS = [
  "cinematic",
  "anime",
  "documentary",
  "funny/comedy",
  "educational",
  "horror",
  "luxury-ad",
  "ugc-tiktok",
] as const;
export type StylePreset = (typeof STYLE_PRESETS)[number];

export const TONES = [
  "epic",
  "playful",
  "calm",
  "motivational",
  "dramatic",
  "minimal",
] as const;
export type TonePreset = (typeof TONES)[number];

export const LANGUAGES = [
  "English",
  "German",
  "French",
  "Spanish",
  "Italian",
  "Portuguese",
  "Dutch",
  "Polish",
  "Turkish",
  "Arabic",
  "Hindi",
  "Japanese",
] as const;

export const DEFAULT_LANGUAGE = "English";

/**
 * Step 1 draft persistence (localStorage only, never committed).
 * Saves "Describe your idea" + "Video settings (optional)" so a reload
 * keeps: topic, negative prompt, scene count, duration, aspect.
 */
export const TOPIC_STORAGE_KEY = "vidiomaker.topic";
export const VIDEO_OPTIONS_STORAGE_KEY = "vidiomaker.video_options";

function clampDraftInt(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  const rounded = Math.round(num);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

/** Plain-text only: strip HTML tags before persisting (XSS rule). */
function sanitizeDraftText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/<[^>]*>/g, "").slice(0, maxLength);
}

export interface TopicDraft {
  topic: string;
  options: VideoOptions;
}

/** Load the saved Step 1 draft (empty topic + defaults when nothing stored). */
export function loadTopicDraft(): TopicDraft {
  const fallback: TopicDraft = {
    topic: "",
    options: { ...DEFAULT_VIDEO_OPTIONS },
  };
  if (typeof window === "undefined") return fallback;
  try {
    const topic = sanitizeDraftText(
      window.localStorage.getItem(TOPIC_STORAGE_KEY) ?? "",
      2000,
    );
    const raw = window.localStorage.getItem(VIDEO_OPTIONS_STORAGE_KEY);
    if (!raw) return { topic, options: { ...DEFAULT_VIDEO_OPTIONS } };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return { topic, options: { ...DEFAULT_VIDEO_OPTIONS } };
    }
    const record = parsed as Record<string, unknown>;
    const aspect: VideoAspect =
      record.aspect === "1920x1080" ? "1920x1080" : "1080x1920";
    const negativeRaw = sanitizeDraftText(record.negativePrompt, 500).trim();
    return {
      topic,
      options: {
        sceneCount: clampDraftInt(
          record.sceneCount,
          MIN_SCENE_COUNT,
          MAX_SCENE_COUNT,
          DEFAULT_VIDEO_OPTIONS.sceneCount,
        ),
        duration: clampDraftInt(
          record.duration,
          MIN_SCENE_DURATION,
          MAX_SCENE_DURATION,
          DEFAULT_VIDEO_OPTIONS.duration,
        ),
        aspect,
        ...(negativeRaw.length > 0 ? { negativePrompt: negativeRaw } : {}),
      },
    };
  } catch {
    return fallback;
  }
}

/** Persist the Step 1 draft (called on every keystroke/setting change). */
export function saveTopicDraft(topic: string, opts: VideoOptions): void {
  if (typeof window === "undefined") return;
  try {
    const cleanTopic = sanitizeDraftText(topic, 2000);
    if (cleanTopic.trim().length === 0) {
      window.localStorage.removeItem(TOPIC_STORAGE_KEY);
    } else {
      window.localStorage.setItem(TOPIC_STORAGE_KEY, cleanTopic);
    }
    const cleanNegative = sanitizeDraftText(opts.negativePrompt ?? "", 500).trim();
    const payload: VideoOptions = {
      sceneCount: clampDraftInt(
        opts.sceneCount,
        MIN_SCENE_COUNT,
        MAX_SCENE_COUNT,
        DEFAULT_VIDEO_OPTIONS.sceneCount,
      ),
      duration: clampDraftInt(
        opts.duration,
        MIN_SCENE_DURATION,
        MAX_SCENE_DURATION,
        DEFAULT_VIDEO_OPTIONS.duration,
      ),
      aspect: opts.aspect === "1920x1080" ? "1920x1080" : "1080x1920",
      ...(cleanNegative.length > 0 ? { negativePrompt: cleanNegative } : {}),
    };
    window.localStorage.setItem(
      VIDEO_OPTIONS_STORAGE_KEY,
      JSON.stringify(payload),
    );
  } catch {
    // Storage unavailable (private mode) — in-memory state still works.
  }
}
