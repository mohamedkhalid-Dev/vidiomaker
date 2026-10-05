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
