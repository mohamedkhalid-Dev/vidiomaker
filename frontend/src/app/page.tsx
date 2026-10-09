"use client";

import { useCallback, useEffect, useState } from "react";
import ErrorAlert from "../components/ErrorAlert";
import CustomInstructions, {
  type CustomInstructionsValue,
  EMPTY_CUSTOM_VALUE,
} from "../components/CustomInstructions";
import ImageGrid, { type ImageGridScene } from "../components/ImageGrid";
import ImageInput, { type UploadedImageItem } from "../components/ImageInput";
import ImageModelPicker from "../components/ImageModelPicker";
import ModelPicker from "../components/ModelPicker";
import ScriptEditor, { type ScriptScene } from "../components/ScriptEditor";
import TopicInput, { type VideoOptions } from "../components/TopicInput";
import VideoPreview from "../components/VideoPreview";
import { isRateLimitedMessage, toUserMessage } from "../lib/errors";
import {
  IMAGE_MODEL_STORAGE_KEY,
  IMAGE_STEPS_STORAGE_KEY,
  normalizeImageModel,
  normalizeImageSteps,
  readStoredImageSteps,
} from "../lib/cloudflare";
import { MODEL_STORAGE_KEY } from "../lib/openrouter";
import { loadTopicDraft } from "../lib/types";
import {
  clearCustomInstructions,
  loadCustomInstructions,
  sanitizeInstructions,
  saveCustomInstructions,
} from "../lib/customInstructions";
import {
  generateScriptWithOptions,
  regenerateScriptScene,
} from "../lib/api";
import {
  generateAllSceneImages,
  persistSceneImage,
  randomImageSeed,
  regenerateSceneImage,
} from "../lib/images";
import { rewriteImagePrompt } from "../lib/rewritePrompt";
import {
  assignLibraryImage,
  isLibrarySelection,
  logLibraryAssign,
  revertLibraryImage,
  type LibraryImageSelection,
  type LibrarySceneOverride,
} from "../lib/libraryImages";

const STEPS = [
  { label: "Describe", help: "Your idea + options" },
  { label: "Script", help: "Check the words" },
  { label: "Images", help: "Make the pictures" },
  { label: "Video", help: "Watch + download" },
] as const;

const STEP_TITLES = [
  "Step 1 of 4 — Describe your idea",
  "Step 2 of 4 — Check your story",
  "Step 3 of 4 — Make the pictures",
  "Step 4 of 4 — Watch your video",
] as const;

const STEP_HINTS = [
  "Type one idea, press one button. Everything else is optional.",
  "Read each part, fix any words, then continue.",
  "One tap makes a picture for every part.",
  "Preview, render, then download your MP4.",
] as const;

const THEME = {
  text: "#B8B8B8",
  muted: "#808080",
  card: "#111",
  border: "#2A2A2A",
  button: "#1A1A1A",
  heading: "#D4D4D4",
} as const;

/** Stage 6.3: all wizard errors render through <ErrorAlert/> (401 → Settings
 * link, 429 → auto-retry countdown, network → retry hint). */
function WizardError({
  message,
  onRetry,
  autoRetry = false,
}: {
  message: string | null;
  onRetry?: () => void;
  autoRetry?: boolean;
}) {
  return (
    <ErrorAlert
      message={message}
      onRetry={onRetry}
      autoRetry={autoRetry}
      retryLabel="Retry"
    />
  );
}

function LoadingSkeleton({ label }: { label: string }) {
  return (
    <div aria-busy="true" aria-label={label} style={{ display: "grid", gap: 12 }}>
      {[0, 1, 2].map((index) => (
        <div
          key={index}
          style={{
            minHeight: 64,
            borderRadius: 8,
            border: `1px solid ${THEME.border}`,
            background: `linear-gradient(90deg, ${THEME.card} 25%, #1c1c1c 50%, ${THEME.card} 75%)`,
            backgroundSize: "200% 100%",
            animation: "vidiomaker-pulse 1.4s ease-in-out infinite",
          }}
        />
      ))}
      <style>{`@keyframes vidiomaker-pulse { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }`}</style>
    </div>
  );
}

function readPersistedModel(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(MODEL_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function readPersistedImageModel(): string {
  if (typeof window === "undefined") return "";
  try {
    return normalizeImageModel(
      window.localStorage.getItem(IMAGE_MODEL_STORAGE_KEY) ?? ""
    );
  } catch {
    return "";
  }
}

function readPersistedImageSteps(): number {
  if (typeof window === "undefined") return readStoredImageSteps();
  try {
    return normalizeImageSteps(
      window.localStorage.getItem(IMAGE_STEPS_STORAGE_KEY) ?? ""
    );
  } catch {
    return readStoredImageSteps();
  }
}

function navButtonStyle(disabled: boolean, primary = false): React.CSSProperties {
  return {
    minHeight: 48,
    minWidth: 44,
    padding: "10px 20px",
    borderRadius: 8,
    border: primary ? "1px solid #E8E8E8" : `1px solid ${THEME.border}`,
    background: primary ? "#E8E8E8" : THEME.button,
    color: primary ? "#000" : THEME.heading,
    fontSize: 16,
    fontWeight: primary ? 700 : 400,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
  };
}

function detailsStyle(): React.CSSProperties {
  return {
    border: `1px solid ${THEME.border}`,
    borderRadius: 10,
    padding: "0.6rem 0.75rem",
    background: THEME.card,
  };
}

function summaryStyle(): React.CSSProperties {
  return {
    cursor: "pointer",
    minHeight: 44,
    display: "flex",
    alignItems: "center",
    color: THEME.heading,
    fontWeight: 600,
    fontSize: 15,
  };
}

export default function CreatePage() {
  const [activeStepIdx, setActiveStepIdx] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // --- Step 1: Input state (Stage 3: TopicInput + ImageInput own the form UI;
  // this page keeps the last submitted values for regen + images/aspect steps).
  const [topic, setTopic] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [sceneCount, setSceneCount] = useState(5);
  const [durationPerScene, setDurationPerScene] = useState(5);
  const [aspect, setAspect] = useState<VideoOptions["aspect"]>("1080x1920");
  // Supabase `uploads/` items (ImageInput uploads + previews them directly).
  const [uploadedImages, setUploadedImages] = useState<UploadedImageItem[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [imageModel, setImageModel] = useState("");

  // --- Custom instructions for the script-writing model (saved in this
  // browser so you don't re-type them every day). Hydrated from the same
  // keys the Settings page writes, autosaved on every change.
  const [creative, setCreative] = useState<CustomInstructionsValue>(EMPTY_CUSTOM_VALUE);
  const [creativeNote, setCreativeNote] = useState<string | null>(null);

  // --- Step 2: Script state ---
  const [videoId, setVideoId] = useState<string | null>(null);
  const [videoTitle, setVideoTitle] = useState("");
  const [scenes, setScenes] = useState<ScriptScene[]>([]);
  const [usedModelId, setUsedModelId] = useState("");
  const [generating, setGenerating] = useState(false);
  const [regeneratingIdx, setRegeneratingIdx] = useState<number | null>(null);
  const [sceneErrors, setSceneErrors] = useState<Record<number, string | null>>(
    {},
  );

  // --- Step 3: Images state (Cloudflare Workers AI, selectable FLUX model) ---
  const [imageUrls, setImageUrls] = useState<Record<number, string>>({});
  const [imageStatuses, setImageStatuses] = useState<
    Record<number, ImageGridScene["status"]>
  >({});
  const [imagesLoading, setImagesLoading] = useState(false);
  const [imagesError, setImagesError] = useState<string | null>(null);

  // --- Agent 2: single-image remake (one disliked card only, rest frozen) ---
  // `remakingIdx` = card currently fetching its replacement still (others stay
  // interactive). `rewritingIdx` = card whose prompt Agent 1 is AI-rewriting
  // (owned by the rewrite flow; kept here so ImageGrid props stay wired).
  // `promptDrafts[idx]` = edited/new AI prompt per scene (falls back to
  // scenes[idx].imagePrompt when untouched). `remakeErrors[idx]` = per-card
  // friendly failure for the single remake (global banner stays clear).
  const [remakingIdx, setRemakingIdx] = useState<number | null>(null);
  const [rewritingIdx, setRewritingIdx] = useState<number | null>(null);
  const [promptDrafts, setPromptDrafts] = useState<Record<number, string>>({});
  const [remakeErrors, setRemakeErrors] = useState<Record<number, string | null>>(
    {},
  );

  // --- Agent 5: library-image integration ---
  // The picker-selected image ({ url, id }) waiting to be assigned, plus
  // per-scene overrides (scene currently shows a library still). Overrides
  // stash the previous URL + seed so Revert restores generated/uploaded
  // stills byte-for-byte (uploads are never clobbered without a way back).
  const [libraryUrlInput, setLibraryUrlInput] = useState("");
  const [libraryIdInput, setLibraryIdInput] = useState("");
  const [libraryOverrides, setLibraryOverrides] = useState<
    Record<number, LibrarySceneOverride>
  >({});
  const librarySelection: LibraryImageSelection | null =
    libraryUrlInput.trim().length > 0 && libraryIdInput.trim().length > 0
      ? { url: libraryUrlInput.trim(), id: libraryIdInput.trim() }
      : null;

  // Hydrate persisted models (ModelPicker + ImageModelPicker persist on select) +
  // saved custom instructions (Settings page writes the same keys) +
  // Step 1 draft (idea + video settings) so a reload keeps the form.
  useEffect(() => {
    setSelectedModel(readPersistedModel());
    setImageModel(readPersistedImageModel());
    try {
      const draft = loadTopicDraft();
      if (draft.topic.trim().length > 0) setTopic(draft.topic);
      if (draft.options.negativePrompt !== undefined) {
        setNegativePrompt(draft.options.negativePrompt ?? "");
      }
      setSceneCount(draft.options.sceneCount);
      setDurationPerScene(draft.options.duration);
      setAspect(draft.options.aspect);
    } catch {
      // Storage unavailable — defaults stand.
    }
    try {
      const stored = loadCustomInstructions();
      setCreative({
        customInstructions: stored.customInstructions,
        stylePreset: stored.stylePreset,
        tone: stored.tone,
        language: stored.language,
        targetAudience: stored.targetAudience,
      });
    } catch {
      // Storage unavailable — defaults stand.
    }
  }, []);

  function handleCreativeChange(next: CustomInstructionsValue): void {
    setCreative(next);
    setCreativeNote(null);
    // Autosave: the next video starts with these values, no daily re-typing.
    try {
      saveCustomInstructions({
        ...next,
        customInstructions: sanitizeInstructions(next.customInstructions),
      });
    } catch {
      // Storage unavailable — in-memory state still applies to this video.
    }
  }

  function handleSaveCreativeDefault(): void {
    try {
      saveCustomInstructions({
        ...creative,
        customInstructions: sanitizeInstructions(creative.customInstructions),
      });
      setCreativeNote("Instructions saved in this browser — used for every new script.");
    } catch {
      setCreativeNote("Could not save (storage unavailable) — still used for this video.");
    }
  }

  function handleClearCreative(): void {
    try {
      clearCustomInstructions();
    } catch {
      // Ignore storage errors.
    }
    const stored = loadCustomInstructions();
    setCreative({
      customInstructions: stored.customInstructions,
      stylePreset: stored.stylePreset,
      tone: stored.tone,
      language: stored.language,
      targetAudience: stored.targetAudience,
    });
    setCreativeNote("Instructions cleared.");
  }

  function goToStep(idx: number) {
    // Guard forward jumps that need a story first (plain words, no codes).
    if (idx >= 1 && scenes.length === 0 && !generating) {
      setError(
        activeStepIdx === 0
          ? error
          : "No story yet — press “Generate my script” in Step 1 first.",
      );
      if (idx >= 1 && activeStepIdx !== 0) return;
    }
    setActiveStepIdx(idx);
    if (idx < 1 || scenes.length > 0) setError(null);
  }

  async function handleGenerateWith(topicValue: string, opts: VideoOptions) {
    setError(null);
    const cleanTopic = topicValue.trim();
    if (cleanTopic.length === 0) {
      setError("Tell us your idea first — one sentence is enough. Example: a brave kid explores a glowing cave.");
      return;
    }
    const model = (selectedModel || readPersistedModel()).trim();
    if (model.length === 0) {
      setError("Pick a writing model first — open “Writing model” below and tap one, then press Generate again.");
      return;
    }
    // Remember the last submitted options for regen + images/aspect steps.
    setTopic(cleanTopic);
    setNegativePrompt(opts.negativePrompt ?? "");
    setSceneCount(opts.sceneCount);
    setDurationPerScene(opts.duration);
    setAspect(opts.aspect);
    setGenerating(true);
    try {
      const result = await generateScriptWithOptions(cleanTopic, model, {
        sceneCount: opts.sceneCount,
        durationPerScene: opts.duration,
        aspect: opts.aspect,
        negativePrompt: opts.negativePrompt,
        // Saved custom instructions travel with every script request —
        // no need to re-type them daily.
        ...(creative.customInstructions.trim()
          ? { customInstructions: creative.customInstructions.trim() }
          : {}),
        ...(creative.stylePreset.trim() ? { stylePreset: creative.stylePreset.trim() } : {}),
        ...(creative.tone.trim() ? { tone: creative.tone.trim() } : {}),
        ...(creative.language.trim() ? { language: creative.language.trim() } : {}),
        ...(creative.targetAudience.trim()
          ? { targetAudience: creative.targetAudience.trim() }
          : {}),
      });
      // Backend assigns seeds when available; client fills the rest.
      // Single replace (not per-scene wipe on later regens).
      setScenes(result.scenes);
      setVideoTitle(result.title);
      setVideoId(result.videoId ?? null);
      setImageUrls({});
      setImageStatuses({});
      setLibraryOverrides({});
      setLibraryUrlInput("");
      setLibraryIdInput("");
      setImagesError(null);
      setUsedModelId(model);
      setSceneErrors({});
      // Single-remake drafts follow the script — fresh story = fresh drafts.
      setPromptDrafts({});
      setRemakeErrors({});
      setRemakingIdx(null);
      setRewritingIdx(null);
      setActiveStepIdx(1);
    } catch (err) {
      // Network failures become the retry hint; 401/429/422 pass through
      // with their actionable text (ErrorAlert adds Settings link/countdown).
      setError(
        toUserMessage(
          err,
          "Could not generate the script. Please check your connection and retry."
        )
      );
    } finally {
      setGenerating(false);
    }
  }

  // Retry entry for the step-0 error banner (reuses the last submitted values).
  async function handleGenerate() {
    await handleGenerateWith(
      topic,
      {
        sceneCount,
        duration: durationPerScene,
        aspect,
        ...(negativePrompt.trim().length > 0
          ? { negativePrompt: negativePrompt.trim() }
          : {}),
      },
    );
  }

  const handleSceneChange = useCallback(
    (idx: number, patch: Partial<ScriptScene>) => {
      // Update ONLY the targeted scene — never wipe the others.
      setScenes((prev) =>
        prev.map((scene) =>
          scene.idx === idx ? { ...scene, ...patch } : scene,
        ),
      );
      // Keep the Images-step draft in sync when the prompt text changes
      // (script edit or AI script regen) — otherwise the card would show
      // a stale draft while scenes[idx] already changed.
      if (patch.imagePrompt !== undefined) {
        const clean = patch.imagePrompt.trim();
        setPromptDrafts((prev) => ({ ...prev, [idx]: clean }));
      }
    },
    [],
  );

  const handleRegenerate = useCallback(
    async (idx: number) => {
      setRegeneratingIdx(idx);
      setSceneErrors((prev) => ({ ...prev, [idx]: null }));
      setError(null);
      try {
        const current = scenes.find((scene) => scene.idx === idx);
        const model = (selectedModel || readPersistedModel()).trim();
        const patch = await regenerateScriptScene({
          idx,
          topic: topic.trim() || undefined,
          model: model || usedModelId || undefined,
          narration: current?.narration,
          imagePrompt: current?.imagePrompt,
          videoId: videoId ?? undefined,
          customInstructions: creative.customInstructions.trim() || undefined,
          stylePreset: creative.stylePreset.trim() || undefined,
          tone: creative.tone.trim() || undefined,
          language: creative.language.trim() || undefined,
          targetAudience: creative.targetAudience.trim() || undefined,
        });
        // Merge ONLY into this idx — other scenes untouched.
        // Agent 5: a library-overridden scene keeps its still — the script
        // regen only rewrites words (narration/imagePrompt/duration). The
        // library seed stays NULL (patch.seed is dropped) and the library
        // URL is re-persisted below (the /api/regenerate-scene route resets
        // image_url to NULL server-side when DB-backed).
        const keepsLibraryImage = libraryOverrides[idx] !== undefined;
        const patchWithoutSeed =
          keepsLibraryImage && patch.seed !== undefined
            ? ((): Partial<ScriptScene> => {
                const { seed: _dropped, ...rest } = patch;
                return rest;
              })()
            : patch;
        setScenes((prev) =>
          prev.map((scene) =>
            scene.idx === idx
              ? keepsLibraryImage
                ? { ...scene, ...patchWithoutSeed, seed: null }
                : { ...scene, ...patchWithoutSeed }
              : scene,
          ),
        );
        // Sync the Images-step draft when the script regen rewrote the prompt.
        if (typeof patch.imagePrompt === "string" && patch.imagePrompt.trim().length > 0) {
          const freshPrompt = patch.imagePrompt.trim();
          setPromptDrafts((prev) => ({ ...prev, [idx]: freshPrompt }));
        }
        if (keepsLibraryImage && videoId) {
          const kept = libraryOverrides[idx];
          // Fire-and-forget: restores image_url + NULL seed on the row the
          // route just nulled. In-memory imageUrls[idx] never changed, so
          // preview + render keep working even if this write is RLS-rejected.
          void persistSceneImage(videoId, idx, kept.url, null).then(() =>
            logLibraryAssign(idx, { url: kept.url, id: kept.id }),
          );
        }
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : "Could not regenerate this scene. Please retry.";
        // Per-scene inline error; global banner stays clear so other
        // scenes remain editable.
        setSceneErrors((prev) => ({ ...prev, [idx]: message }));
      } finally {
        setRegeneratingIdx(null);
      }
    },
    [scenes, selectedModel, topic, usedModelId, videoId, creative, libraryOverrides],
  );

  const imageGridScenes: ImageGridScene[] = scenes.map((scene) => ({
    idx: scene.idx,
    imagePrompt: scene.imagePrompt,
    // Library-overridden scenes report a NULL seed (logged model_id='library').
    // ScriptEditor allows seed string|number|null; ImageGrid logs "library".
    seed:
      libraryOverrides[scene.idx] !== undefined || scene.seed === null
        ? null
        : typeof scene.seed === "number"
          ? scene.seed
          : Number(scene.seed) || 0,
    imageUrl: imageUrls[scene.idx],
    status: imageStatuses[scene.idx] ?? (imageUrls[scene.idx] ? "ready" : "pending"),
    // Editable caption: same text burned onto the canvas + final MP4.
    narration: scene.narration,
  }));

  const handleCaptionChange = useCallback((idx: number, narration: string) => {
    setScenes((prev) =>
      prev.map((scene) => (scene.idx === idx ? { ...scene, narration } : scene)),
    );
  }, []);

  /**
   * Agent 5 — assign the selected library image to scene `idx`:
   * imageUrls[idx] = library URL (Cloudflare is skipped for it from now on —
   * generateAllSceneImages skips every non-empty image_url), scenes[idx].seed
   * = NULL, persisted as scenes.image_url + seed NULL (logged
   * model_id='library'). Narration/duration are untouched so captions +
   * timing keep working; preview + Render + Download flow through the same
   * path as generated stills. Never overwrites blindly: the previous still
   * (generated OR uploads/ custom photo) is stashed for Revert.
   */
  const handleLibraryAssign = useCallback(
    async (idx: number) => {
      if (!isLibrarySelection(librarySelection)) return;
      const selection: LibraryImageSelection = {
        url: librarySelection.url,
        id: librarySelection.id,
      };
      const target = scenes.find((scene) => scene.idx === idx);
      if (!target) return;
      const next = assignLibraryImage(
        imageUrls,
        libraryOverrides,
        scenes.map((s) => ({ idx: s.idx, seed: s.seed })),
        idx,
        selection,
      );
      setImageUrls(next.imageUrls);
      setLibraryOverrides(next.overrides);
      setImageStatuses((prev) => ({ ...prev, [idx]: "ready" }));
      // Library stills carry no diffusion seed.
      setScenes((prev) =>
        prev.map((scene) =>
          scene.idx === idx ? { ...scene, seed: null } : scene,
        ),
      );
      if (videoId) {
        await persistSceneImage(videoId, idx, selection.url, null);
      }
      logLibraryAssign(idx, selection);
    },
    [librarySelection, scenes, imageUrls, libraryOverrides, videoId],
  );

  /**
   * Agent 5 — revert scene `idx` to the still it had before the library
   * replacement (generated still or uploads/ custom photo), restoring the
   * exact previous URL + seed and persisting both.
   */
  const handleLibraryRevert = useCallback(
    async (idx: number) => {
      const next = revertLibraryImage(imageUrls, libraryOverrides, idx);
      if (libraryOverrides[idx] === undefined) return;
      setImageUrls(next.imageUrls);
      setLibraryOverrides(next.overrides);
      const restoredSeed =
        typeof next.restoredSeed === "number" ||
        typeof next.restoredSeed === "string"
          ? next.restoredSeed
          : null;
      if (next.restoredUrl !== null) {
        setImageStatuses((prev) => ({ ...prev, [idx]: "ready" }));
        setScenes((prev) =>
          prev.map((scene) =>
            scene.idx === idx ? { ...scene, seed: restoredSeed } : scene,
          ),
        );
      } else {
        // The scene had no image before assignment — back to pending so the
        // next Generate-images pass picks it up (resume path).
        setImageStatuses((prev) => ({ ...prev, [idx]: "pending" }));
        setScenes((prev) =>
          prev.map((scene) =>
            scene.idx === idx
              ? { ...scene, seed: randomImageSeed() }
              : scene,
          ),
        );
      }
      if (videoId && next.restoredUrl !== null) {
        await persistSceneImage(
          videoId,
          idx,
          next.restoredUrl,
          typeof restoredSeed === "number" ? restoredSeed : null,
        );
      }
    },
    [imageUrls, libraryOverrides, videoId],
  );

  const handleGenerateImages = useCallback(async () => {
    if (scenes.length === 0) {
      setImagesError("Generate a script first — images need scenes to attach to.");
      return;
    }
    setImagesLoading(true);
    setImagesError(null);
    setImageStatuses((prev) => {
      const next: Record<number, ImageGridScene["status"]> = { ...prev };
      for (const scene of scenes) {
        if (!imageUrls[scene.idx]) next[scene.idx] = "loading";
      }
      return next;
    });
    try {
      const [w, h] = aspect === "1920x1080" ? [1920, 1080] : [1080, 1920];
      const model = normalizeImageModel(imageModel || readPersistedImageModel());
      // Pure-frontend pass over LOCAL scenes (no Supabase video row needed).
      // When the script was persisted server-side (service-role configured)
      // videoId enables Storage upload + scenes.image_url update
      // (best-effort); otherwise in-memory object URLs keep the preview
      // working for this session.
      const inputs = scenes.map((scene) => ({
        idx: scene.idx,
        imagePrompt: scene.imagePrompt,
        seed:
          typeof scene.seed === "number"
            ? scene.seed
            : Number(scene.seed) || randomImageSeed(),
        image_url: imageUrls[scene.idx] ?? null,
      }));
      const result = await generateAllSceneImages(inputs, {
        videoId: videoId ?? undefined,
        w,
        h,
        model,
        steps: readPersistedImageSteps(),
      });
      // lib/images.ts already returns renderable absolute URLs
      // (Supabase public/signed URL, or a blob: object URL for this
      // session) — no URL rebuilding needed (Cloudflare has no
      // deterministic public URL).
      setImageUrls((prev) => {
        const next = { ...prev };
        for (const img of result.images) next[img.idx] = img.image_url;
        return next;
      });
      setImageStatuses((prev) => {
        const next = { ...prev };
        for (const img of result.images) next[img.idx] = "ready";
        // Failed scenes get per-card Retry (ImageGrid) — the next
        // Generate-images pass resumes these missing scenes only.
        for (const failedIdx of result.failed ?? []) next[failedIdx] = "failed";
        return next;
      });
      if (result.failed && result.failed.length > 0) {
        setImagesError(
          `Cloudflare busy, retrying scene ${result.failed.map((i) => i + 1).join(", ")}... Tap Retry on failed cards.`,
        );
      }
    } catch (err) {
      setImagesError(
        toUserMessage(
          err,
          "Cloudflare timed out. Please retry missing scenes."
        )
      );
      // Never leave cards on the shimmer forever — flip missing ones to
      // failed so each shows its own Retry button.
      setImageStatuses((prev) => {
        const next = { ...prev };
        for (const scene of scenes) {
          if (!imageUrls[scene.idx]) next[scene.idx] = "failed";
        }
        return next;
      });
    } finally {
      setImagesLoading(false);
    }
  }, [videoId, scenes, aspect, imageUrls, imageModel]);

  const handleImageRetry = useCallback(
    async (idx: number) => {
      const target = scenes.find((scene) => scene.idx === idx);
      if (!target) return;
      // Explicit same-seed AI retry replaces the library still (the user
      // asked for a generated image); Revert is no longer applicable.
      if (libraryOverrides[idx] !== undefined) {
        setLibraryOverrides((prev) => {
          const next = { ...prev };
          delete next[idx];
          return next;
        });
      }
      setImageStatuses((prev) => ({ ...prev, [idx]: "loading" }));
      setImagesError(null);
      try {
        // Same-seed retry: keep aspect dims so vertical stays 1080x1920
        // and horizontal stays 1920x1080.
        const [w, h] = aspect === "1920x1080" ? [1920, 1080] : [1080, 1920];
        const model = normalizeImageModel(imageModel || readPersistedImageModel());
        const seed =
          typeof target.seed === "number"
            ? target.seed
            : Number(target.seed) || randomImageSeed();
        const position = scenes.findIndex((scene) => scene.idx === idx);
        const { imageUrl } = await regenerateSceneImage(
          target.imagePrompt,
          seed,
          {
            videoId: videoId ?? undefined,
            w,
            h,
            model,
            steps: readPersistedImageSteps(),
            storageIdx: idx,
            sceneIdx: position + 1,
            sceneTotal: scenes.length,
          }
        );
        if (videoId) await persistSceneImage(videoId, idx, imageUrl, seed);
        setImageUrls((prev) => ({ ...prev, [idx]: imageUrl }));
        setImageStatuses((prev) => ({ ...prev, [idx]: "ready" }));
      } catch (err) {
        setImageStatuses((prev) => ({ ...prev, [idx]: "failed" }));
        setImagesError(
          toUserMessage(
            err,
            "Cloudflare timed out. Please retry missing scenes."
          )
        );
      }
    },
    [videoId, aspect, imageModel, scenes, libraryOverrides],
  );

  const handleImageRegen = useCallback(
    async (idx: number) => {
      const target = scenes.find((scene) => scene.idx === idx);
      if (!target) return;
      // Explicit new-seed AI regen replaces the library still (the user
      // asked for a generated image); Revert is no longer applicable.
      if (libraryOverrides[idx] !== undefined) {
        setLibraryOverrides((prev) => {
          const next = { ...prev };
          delete next[idx];
          return next;
        });
      }
      setImageStatuses((prev) => ({ ...prev, [idx]: "loading" }));
      try {
        // New-seed regen: same aspect dims as the initial pass.
        const [w, h] = aspect === "1920x1080" ? [1920, 1080] : [1080, 1920];
        const model = normalizeImageModel(imageModel || readPersistedImageModel());
        const newSeed = randomImageSeed();
        const position = scenes.findIndex((scene) => scene.idx === idx);
        const { imageUrl } = await regenerateSceneImage(
          target.imagePrompt,
          newSeed,
          {
            videoId: videoId ?? undefined,
            w,
            h,
            model,
            steps: readPersistedImageSteps(),
            storageIdx: idx,
            sceneIdx: position + 1,
            sceneTotal: scenes.length,
          }
        );
        if (videoId) await persistSceneImage(videoId, idx, imageUrl, newSeed);
        setImageUrls((prev) => ({ ...prev, [idx]: imageUrl }));
        // Fresh seed from the client so the same prompt+model reproduces it.
        setScenes((prev) =>
          prev.map((scene) =>
            scene.idx === idx ? { ...scene, seed: newSeed } : scene,
          ),
        );
        setImageStatuses((prev) => ({ ...prev, [idx]: "ready" }));
      } catch {
        setImageStatuses((prev) => ({ ...prev, [idx]: "failed" }));
      }
    },
    [videoId, aspect, imageModel, scenes, libraryOverrides],
  );

  /**
   * Agent 2 — apply an edited / AI-rewritten prompt to scene `idx` ONLY.
   * Updates `scenes[idx].imagePrompt` + `promptDrafts[idx]`; the still stays
   * untouched (`imageUrls` / `imageStatuses` never change here) until the user
   * presses Remake. A library override is kept — the prompt change alone does
   * not clear the library picture; only an explicit AI remake does.
   */
  const handleRewritePrompt = useCallback((idx: number, newPrompt: string) => {
    const clean = newPrompt.trim();
    if (clean.length === 0) return;
    setScenes((prev) =>
      prev.map((scene) =>
        scene.idx === idx ? { ...scene, imagePrompt: clean } : scene,
      ),
    );
    setPromptDrafts((prev) => ({ ...prev, [idx]: clean }));
    setRemakeErrors((prev) => ({ ...prev, [idx]: null }));
  }, []);

  /**
   * Agent 2 — remake ONLY scene `idx` with its draft prompt
   * (`promptDrafts[idx] ?? scenes[idx].imagePrompt`). Default is a fresh
   * `randomImageSeed()`; pass `{ seedMode: "same" }` to keep the scene seed
   * (deterministic retry of the new prompt). Merge-only-idx: `setImageUrls`,
   * `setScenes` (preserving narration/duration), `setImageStatuses` touch
   * just `idx`; all other scenes stay frozen (bulk generate still skips every
   * non-empty URL via `hasSceneImage`). On success an existing
   * `libraryOverrides[idx]` is cleared (explicit AI remake replaces the
   * library still); on failure only `idx` flips to failed with a friendly
   * per-card message. `rewritingIdx` is owned by the Agent 1 AI-rewrite flow
   * (card whose prompt is being rewritten); `remakingIdx` / `promptDrafts` /
   * `remakeErrors` below are Agent 3's ImageGrid wiring props (left unwired
   * here — Agent 3 connects the card buttons, no wizard restructure).
   */
  const handleRemakeSingleImage = useCallback(
    async (idx: number, opts?: { seedMode?: "new" | "same" }) => {
      const target = scenes.find((scene) => scene.idx === idx);
      if (!target) return;
      const newPrompt = (promptDrafts[idx] ?? target.imagePrompt).trim();
      if (newPrompt.length === 0) {
        setRemakeErrors((prev) => ({
          ...prev,
          [idx]: "Please describe the scene image first.",
        }));
        return;
      }
      const seedMode = opts?.seedMode ?? "new";
      const currentSeed =
        typeof target.seed === "number"
          ? target.seed
          : Number(target.seed) || null;
      const newSeed =
        seedMode === "same" && typeof currentSeed === "number"
          ? currentSeed
          : randomImageSeed();
      setRemakingIdx(idx);
      setImageStatuses((prev) => ({ ...prev, [idx]: "loading" }));
      setRemakeErrors((prev) => ({ ...prev, [idx]: null }));
      try {
        const [w, h] = aspect === "1920x1080" ? [1920, 1080] : [1080, 1920];
        const model = normalizeImageModel(imageModel || readPersistedImageModel());
        const position = scenes.findIndex((scene) => scene.idx === idx);
        // eslint-disable-next-line no-console
        console.info(
          `[images] single remake idx=${idx} seed=${newSeed} model=${model}`
        );
        const { imageUrl } = await regenerateSceneImage(newPrompt, newSeed, {
          videoId: videoId ?? undefined,
          w,
          h,
          model,
          steps: readPersistedImageSteps(),
          storageIdx: idx,
          sceneIdx: position + 1,
          sceneTotal: scenes.length,
        });
        if (videoId) await persistSceneImage(videoId, idx, imageUrl, newSeed);
        setImageUrls((prev) => ({ ...prev, [idx]: imageUrl }));
        // Preserve narration/duration — only the prompt + seed change.
        setScenes((prev) =>
          prev.map((scene) =>
            scene.idx === idx
              ? { ...scene, imagePrompt: newPrompt, seed: newSeed }
              : scene,
          ),
        );
        setPromptDrafts((prev) => ({ ...prev, [idx]: newPrompt }));
        setImageStatuses((prev) => ({ ...prev, [idx]: "ready" }));
        // Explicit AI remake replaces the library still (same convention as
        // handleImageRetry / handleImageRegen); Revert no longer applies.
        if (libraryOverrides[idx] !== undefined) {
          setLibraryOverrides((prev) => {
            const next = { ...prev };
            delete next[idx];
            return next;
          });
        }
        setRemakeErrors((prev) => ({ ...prev, [idx]: null }));
      } catch (err) {
        setImageStatuses((prev) => ({ ...prev, [idx]: "failed" }));
        setRemakeErrors((prev) => ({
          ...prev,
          [idx]: toUserMessage(
            err,
            "Cloudflare timed out. Please retry this scene."
          ),
        }));
      } finally {
        setRemakingIdx((prev) => (prev === idx ? null : prev));
      }
    },
    [
      videoId,
      aspect,
      imageModel,
      scenes,
      libraryOverrides,
      promptDrafts,
    ],
  );

  // NOTE (Agent 2 → Agent 3): `remakingIdx`, `rewritingIdx`, `promptDrafts`,
  // `remakeErrors`, `handleRewritePrompt(idx, newPrompt)` and
  // `handleRemakeSingleImage(idx, { seedMode })` are intentionally left unwired
  // in the <ImageGrid> JSX below — Agent 3 connects the card buttons via props
  // (e.g. onRewrite/onRemake → these handlers). No wizard restructure here.

  const handlePromptDraftChange = useCallback((idx: number, text: string) => {
    // Live draft first so typing never lags; scenes merge only when non-empty
    // so an intermediate empty textarea doesn't wipe the stored prompt.
    // Still idx-only — other scenes untouched.
    setPromptDrafts((prev) => ({ ...prev, [idx]: text }));
    const clean = text.trim();
    if (clean.length === 0) return;
    setScenes((prev) =>
      prev.map((scene) =>
        scene.idx === idx ? { ...scene, imagePrompt: clean } : scene,
      ),
    );
    setRemakeErrors((prev) => ({ ...prev, [idx]: null }));
  }, []);

  const handleAiRewrite = useCallback(
    async (idx: number) => {
      const target = scenes.find((scene) => scene.idx === idx);
      if (!target) return;
      // Single-flight: one AI rewrite at a time, others stay interactive.
      setRewritingIdx(idx);
      setRemakeErrors((prev) => ({ ...prev, [idx]: null }));
      try {
        const currentPrompt = (promptDrafts[idx] ?? target.imagePrompt).trim();
        if (currentPrompt.length === 0) {
          throw new Error("Please describe the scene image first.");
        }
        const model = (selectedModel || readPersistedModel()).trim();
        const { imagePrompt: fresh } = await rewriteImagePrompt({
          idx,
          imagePrompt: currentPrompt,
          narration: target.narration,
          topic: topic.trim() || undefined,
          stylePreset: creative.stylePreset.trim() || undefined,
          tone: creative.tone.trim() || undefined,
          aspect: aspect === "1920x1080" ? "1920x1080" : "1080x1920",
          model: model || usedModelId || undefined,
        });
        handleRewritePrompt(idx, fresh);
      } catch (err) {
        setRemakeErrors((prev) => ({
          ...prev,
          [idx]:
            err instanceof Error
              ? err.message
              : "Could not rewrite this prompt. Please retry.",
        }));
      } finally {
        setRewritingIdx((prev) => (prev === idx ? null : prev));
      }
    },
    [
      scenes,
      promptDrafts,
      topic,
      creative,
      aspect,
      selectedModel,
      usedModelId,
      handleRewritePrompt,
    ],
  );

  const canGoBack = activeStepIdx > 0;
  const canGoNext = activeStepIdx < STEPS.length - 1;
  const progressPct = Math.round(((activeStepIdx + 1) / STEPS.length) * 100);
  const scriptReady = scenes.length > 0;
  // Single primary CTA per step: step 0's primary lives inside TopicInput
  // ("Generate my script"), so the bottom Next stays secondary there.
  const nextIsPrimary = activeStepIdx !== 0;

  function handleNext() {
    if (activeStepIdx === 0 && scenes.length === 0) {
      setError("Not yet — press “Generate my script” above first, then continue.");
      return;
    }
    if (activeStepIdx === 1 && scenes.length === 0) {
      setError("No story yet. Go back and press “Generate my script” first.");
      return;
    }
    setError(null);
    setActiveStepIdx((prev) => Math.min(prev + 1, STEPS.length - 1));
  }

  function handleBack() {
    setError(null);
    setActiveStepIdx((prev) => Math.max(prev - 1, 0));
  }

  return (
    <section aria-label="Create an AI vertical video" style={{ width: "100%", maxWidth: 720 }}>
      <h1>Create AI vertical videos</h1>
      <p style={{ color: THEME.muted, lineHeight: 1.5, margin: "0 0 12px" }}>
        Type one idea, check the story, make pictures, watch your video.
        Review past renders in <a href="/history">History</a> or
        set your key and defaults in <a href="/settings">Settings</a>.
      </p>

      {/* Clearer step indicator: "Step X of 4" + progress bar + short labels. */}
      <p role="status" style={{ color: THEME.heading, fontWeight: 700, margin: "0 0 4px" }}>
        {STEP_TITLES[activeStepIdx]}
      </p>
      <div
        role="progressbar"
        aria-valuenow={progressPct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Progress: step ${activeStepIdx + 1} of ${STEPS.length}`}
        style={{
          height: 10,
          borderRadius: 999,
          background: "#1A1A1A",
          border: `1px solid ${THEME.border}`,
          overflow: "hidden",
          marginBottom: 8,
        }}
      >
        <div
          style={{
            width: `${progressPct}%`,
            height: "100%",
            background: "#D4D4D4",
            borderRadius: 999,
            transition: "width 0.3s ease",
          }}
        />
      </div>
      <ol
        aria-label="Video creation steps"
        style={{
          listStyle: "none",
          margin: "0 0 12px",
          padding: 0,
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        {STEPS.map((step, idx) => {
          const isActive = idx === activeStepIdx;
          const isDone = scriptReady && idx < activeStepIdx;
          return (
            <li key={step.label} style={{ flex: "1 1 120px", minWidth: 120 }}>
              <button
                type="button"
                onClick={() => goToStep(idx)}
                aria-current={isActive ? "step" : undefined}
                aria-label={`Step ${idx + 1} of ${STEPS.length}: ${step.label} — ${step.help}${isActive ? " (current step)" : ""}`}
                style={{
                  width: "100%",
                  minHeight: 48,
                  padding: "8px 10px",
                  borderRadius: 8,
                  border: `1px solid ${isActive ? THEME.heading : THEME.border}`,
                  background: isActive ? "#1E1E1E" : THEME.button,
                  color: isActive ? THEME.heading : THEME.text,
                  fontSize: 14,
                  fontWeight: isActive ? 700 : 400,
                  cursor: "pointer",
                  textAlign: "center",
                }}
              >
                {idx + 1}. {step.label}
                {isDone ? " ✓" : ""}
                <span style={{ display: "block", fontSize: 12, color: THEME.muted, fontWeight: 400 }}>
                  {step.help}
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      <WizardError
        message={error}
        onRetry={() => void handleGenerate()}
        autoRetry={error !== null && isRateLimitedMessage(error)}
      />

      <div className="card" style={{ display: "grid", gap: 16 }}>
        <h2 style={{ margin: 0 }}>{STEP_TITLES[activeStepIdx]}</h2>
        <p style={{ color: THEME.muted, margin: 0, fontSize: 14, lineHeight: 1.5 }}>
          {STEP_HINTS[activeStepIdx]}
        </p>

        {activeStepIdx === 0 && (
          <div style={{ display: "grid", gap: 12 }}>
            {/* Focal point: one idea box + one big Generate button. */}
            <TopicInput
              initialTopic={topic}
              initialOptions={{
                sceneCount,
                duration: durationPerScene,
                aspect,
                ...(negativePrompt.trim().length > 0
                  ? { negativePrompt: negativePrompt.trim() }
                  : {}),
              }}
              isSubmitting={generating}
              onSubmit={(submittedTopic, opts) =>
                void handleGenerateWith(submittedTopic, opts)
              }
            />

            {/* Advanced: collapsed so first-timers see one CTA only. */}
            <details style={detailsStyle()}>
              <summary style={summaryStyle()}>
                Add your own photos (optional){uploadedImages.length > 0 ? ` — ${uploadedImages.length} added ✓` : " — skip for AI pictures"}
              </summary>
              <div style={{ marginTop: 8 }}>
                <p id="photos-help" style={{ color: THEME.muted, fontSize: 13, margin: "0 0 8px", lineHeight: 1.5 }}>
                  Have pictures? Add them — those parts skip AI drawing. No
                  photos? Skip this, AI draws everything.
                </p>
                <ImageInput
                  value={uploadedImages}
                  onChange={setUploadedImages}
                  videoId={videoId ?? undefined}
                  maxFiles={8}
                  disabled={generating}
                />
              </div>
            </details>

            <details style={detailsStyle()}>
              <summary style={summaryStyle()}>
                {selectedModel ? "Writing model ✓ (tap to change)" : "Writing model (required) — pick one"}
              </summary>
              <div style={{ marginTop: 8 }}>
                <ModelPicker
                  selectedModel={selectedModel}
                  onSelect={setSelectedModel}
                  defaultOpen={false}
                />
              </div>
            </details>

            <details style={detailsStyle()}>
              <summary style={summaryStyle()}>Story style (optional) — default is fine</summary>
              <div style={{ marginTop: 8, display: "grid", gap: 8 }}>
                <CustomInstructions
                  value={creative}
                  onChange={handleCreativeChange}
                  onSaveDefault={handleSaveCreativeDefault}
                  onClear={handleClearCreative}
                  idPrefix="create-ci"
                  defaultOpen={false}
                />
                {creativeNote ? (
                  <p role="status" style={{ color: THEME.muted, fontSize: 14, margin: 0 }}>
                    {creativeNote}
                  </p>
                ) : null}
              </div>
            </details>

            {generating && <LoadingSkeleton label="Generating script" />}
            {selectedModel.trim().length === 0 && !generating ? (
              <p role="note" style={{ color: "#D4A0A0", margin: 0, fontSize: 14, lineHeight: 1.5 }}>
                One more thing: open “Writing model” above and tap a model —
                then Generate works.
              </p>
            ) : null}
          </div>
        )}

        {activeStepIdx === 1 && (
          <div style={{ display: "grid", gap: 12 }}>
            {generating ? (
              <LoadingSkeleton label="Loading script" />
            ) : (
              <ScriptEditor
                scenes={scenes}
                onChange={handleSceneChange}
                onRegenerate={handleRegenerate}
                modelId={usedModelId || selectedModel}
                title={videoTitle}
                regeneratingIdx={regeneratingIdx}
                sceneErrors={sceneErrors}
                imageUrls={imageUrls}
                aspect={aspect === "1920x1080" ? "1920x1080" : "1080x1920"}
              />
            )}
          </div>
        )}

        {activeStepIdx === 2 && (
          <div id="images-step" style={{ display: "grid", gap: 12 }}>
            <p style={{ color: THEME.muted, margin: 0, fontSize: 14, lineHeight: 1.5 }}>
              Default look works for most videos. One tap below draws every
              part — failed ones show their own Retry.
            </p>
            {/* Single image-model picker (was duplicated in Input + Images). */}
            <ImageModelPicker
              selectedModel={imageModel}
              onSelect={setImageModel}
            />
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => void handleGenerateImages()}
                disabled={imagesLoading || scenes.length === 0}
                aria-describedby="images-help"
                style={{
                  ...navButtonStyle(imagesLoading || scenes.length === 0, true),
                  flex: "1 1 200px",
                }}
              >
                {imagesLoading ? "Drawing pictures…" : scriptReady ? `Make ${scenes.length} pictures →` : "Make pictures →"}
              </button>
            </div>
            <p id="images-help" style={{ color: THEME.muted, margin: 0, fontSize: 13, lineHeight: 1.5 }}>
              {imagesLoading ? "Drawing… keep this tab open." : "Each picture matches one story part."}
            </p>
            <WizardError
              message={imagesError}
              onRetry={() => void handleGenerateImages()}
              autoRetry={imagesError !== null && isRateLimitedMessage(imagesError)}
            />
            {scenes.length === 0 ? (
              <p style={{ margin: 0, lineHeight: 1.5 }}>
                No story yet — go back to Step 1 and press “Generate my script”
                first, then pictures appear here.
              </p>
            ) : (
              <ImageGrid
                scenes={imageGridScenes}
                aspect={aspect === "1920x1080" ? "1920x1080" : "1080x1920"}
                onRegen={handleImageRegen}
                onRetry={handleImageRetry}
                onNarrationChange={handleCaptionChange}
                libraryImage={librarySelection}
                libraryOverrides={libraryOverrides}
                onLibraryAssign={(idx) => void handleLibraryAssign(idx)}
                onLibraryRevert={(idx) => void handleLibraryRevert(idx)}
                promptDrafts={promptDrafts}
                onPromptDraftChange={handlePromptDraftChange}
                onAiRewrite={(idx) => void handleAiRewrite(idx)}
                onRemakeSingle={(idx) => void handleRemakeSingleImage(idx)}
                rewritingIdx={rewritingIdx}
                remakingIdx={remakingIdx}
                remakeErrors={remakeErrors}
              />
            )}
            {/* Agent 5 — library image picker bridge (the full picker UI lives
                with the library agent; these two fields accept its {url, id}
                selection so per-card Replace/Revert works end-to-end). */}
            <details style={detailsStyle()}>
              <summary style={summaryStyle()}>
                Use a library picture instead (optional)
                {librarySelection ? " — 1 selected ✓" : " — paste URL + ID"}
              </summary>
              <div style={{ marginTop: 8, display: "grid", gap: 8 }}>
                <p style={{ color: THEME.muted, fontSize: 13, margin: 0, lineHeight: 1.5 }}>
                  Paste a library image URL + ID, then tap “Replace with
                  library image” on any scene card. That scene skips AI
                  drawing (logged seed NULL, model_id=&apos;library&apos;) and
                  keeps its caption; “Revert to generated” restores the
                  previous picture.
                </p>
                <label style={{ display: "grid", gap: 4, fontSize: 13, color: THEME.muted }}>
                  <span>Library image URL</span>
                  <input
                    type="url"
                    value={libraryUrlInput}
                    onChange={(e) => setLibraryUrlInput(e.target.value)}
                    placeholder="https://…/my-picture.jpg"
                    inputMode="url"
                    aria-label="Library image URL"
                    style={{
                      width: "100%",
                      minHeight: 44,
                      padding: "10px 12px",
                      borderRadius: 8,
                      border: `1px solid ${THEME.border}`,
                      background: "#000",
                      color: THEME.text,
                      fontSize: 14,
                      boxSizing: "border-box",
                    }}
                  />
                </label>
                <label style={{ display: "grid", gap: 4, fontSize: 13, color: THEME.muted }}>
                  <span>Library image ID</span>
                  <input
                    type="text"
                    value={libraryIdInput}
                    onChange={(e) => setLibraryIdInput(e.target.value)}
                    placeholder="e.g. lib_abc123"
                    maxLength={120}
                    aria-label="Library image ID"
                    style={{
                      width: "100%",
                      minHeight: 44,
                      padding: "10px 12px",
                      borderRadius: 8,
                      border: `1px solid ${THEME.border}`,
                      background: "#000",
                      color: THEME.text,
                      fontSize: 14,
                      boxSizing: "border-box",
                    }}
                  />
                </label>
                {Object.keys(libraryOverrides).length > 0 ? (
                  <p role="status" style={{ color: THEME.muted, fontSize: 13, margin: 0 }}>
                    Library pictures in use: scene{" "}
                    {Object.keys(libraryOverrides)
                      .map((k) => Number(k) + 1)
                      .join(", scene ")}
                    . Preview, Render and Download include them with captions.
                  </p>
                ) : null}
              </div>
            </details>
          </div>
        )}

        {activeStepIdx === 3 && (
          <div id="video-step" style={{ display: "grid", gap: 12 }}>
            <VideoPreview
              videoId={videoId}
              title={videoTitle || topic.trim() || "Untitled video"}
              images={scenes
                .map((scene) => imageUrls[scene.idx])
                .filter(
                  (url): url is string =>
                    typeof url === "string" && url.length > 0,
                )}
              scenes={scenes.map((scene) => ({
                imageUrl: imageUrls[scene.idx] ?? "",
                narration: scene.narration,
                duration: scene.duration,
              }))}
              aspect={aspect === "1920x1080" ? "1920x1080" : "1080x1920"}
            />
            {!videoId && (
              <p style={{ margin: 0, color: THEME.muted, lineHeight: 1.5 }}>
                Nothing to watch yet — go back to Step 1, press “Generate my
                script”, then Step 3 draws pictures.
              </p>
            )}
          </div>
        )}

        <nav
          aria-label="Wizard navigation"
          style={{
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
            justifyContent: "space-between",
          }}
        >
          <button
            type="button"
            onClick={handleBack}
            disabled={!canGoBack}
            style={navButtonStyle(!canGoBack, false)}
          >
            ← Back
          </button>
          <button
            type="button"
            onClick={handleNext}
            disabled={!canGoNext}
            style={navButtonStyle(!canGoNext, nextIsPrimary)}
          >
            {activeStepIdx === 0 ? "Review script →" : activeStepIdx === 1 ? "Make images →" : "Watch video →"}
          </button>
        </nav>
      </div>
    </section>
  );
}
