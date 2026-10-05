/**
 * Client-side MP4 assembly via Canvas 2D + MediaRecorder (no FFmpeg, no Laravel).
 *
 * TEXT-BURN STRATEGY: **per-frame Canvas 2D overlay** (crisp, locked captions).
 * Each animation frame draws the Ken Burns image FIRST, then the narration
 * caption bottom-center on an identity transform — so text never zooms/pans
 * with the image and stays readable at full resolution on every frame.
 * (The old pre-burned-still path baked text into a JPEG once; per-frame vector
 * text is sharper and immune to JPEG artefacts around glyph edges.)
 * Zero font-file dependencies, immune to filter-injection (`'`, `:` need no
 * escaping on a 2D context). `escapeDrawtext()` is kept (mirrors the old
 * backend FfmpegService) for any future drawtext path — NOT on this path.
 *
 * Pipeline:
 *   scene image bytes → ImageBitmap → rAF loop (Ken Burns cover-fit + caption)
 *   → canvas.captureStream(25) → MediaRecorder (MP4) → Blob → upload.
 *
 * MP4 GUARANTEE: `pickMp4MimeType()` probes, in order,
 *   1. `video/mp4;codecs="avc1.42E01E,mp4a.40.2"` (Chrome/Edge/Safari H.264+AAC)
 *   2. `video/mp4;codecs=avc1`
 *   3. `video/mp4`
 * and logs the winner. Only when none is supported (e.g. Firefox, which
 * records WebM only) does it fall back to `video/webm;codecs=vp9` — the Blob
 * type + file extension switch to `.webm` accordingly and a warning is
 * surfaced via `onMimeWarning` so the UI can tell the user.
 * Bitrate: 8 Mbps vertical / 10 Mbps horizontal @ 25 fps. MP4 from
 * MediaRecorder is fragmented-streamable (faststart-like: plays before the
 * full download, works in `<video preload="metadata">` immediately).
 *
 * BROWSER SUPPORT MATRIX (MediaRecorder MP4):
 *   Chrome 126+ / Edge 126+  — video/mp4 (avc1) ✅ (target path)
 *   Safari 17+ (macOS/iOS)    — video/mp4 ✅ (target path)
 *   Firefox (all current)     — NO video/mp4; VP9/WebM fallback + UI warning ⚠️
 *   Older browsers w/o MediaRecorder/captureStream — friendly throw, no render.
 *
 * PERFORMANCE (lighter/faster proof vs the old ffmpeg.wasm path):
 *   - No ~30 MB wasm core download, no `toBlobURL` staging, no wasm heap.
 *   - No single-thread `exec` queue: a 5 s scene encodes in ~5 s wall-clock
 *     (real-time capture), total render ≈ sum(scene durations) + decode time.
 *   - Low memory: sequential bitmap decode, `bitmap.close()` after use, no
 *     object URLs for intermediates (fetch → Blob → ImageBitmap directly),
 *     recorder chunks are small (~1 MB/s) and copied out of the media
 *     pipeline into one final Blob. Callers revoke the preview URL when done.
 *   - No jank: caption lines are wrapped ONCE per scene (measure is the only
 *     layout-ish cost); the per-frame loop only does drawImage + fillText /
 *     strokeText driven by rAF timestamps, with no DOM reads per frame.
 */

export type RenderAspect = "1080x1920" | "1920x1080";

export interface RenderSceneInput {
  imageUrl: string;
  narration?: string | null;
  duration?: number | null;
}

export interface RenderVideoClientOptions {
  scenes: RenderSceneInput[];
  aspect?: RenderAspect;
  /** Optional per-scene/index-aligned TTS MP3 URLs (WebAudio mux, best-effort). */
  audioUrls?: string[];
  signal?: AbortSignal;
  /** 0–100 render progress (decode ≈ 2–10, capture ≈ 10–95, finalize ≈ 96–100). */
  onProgress?: (progress: number) => void;
  /**
   * Called once with a non-null message when the MP4 path is unavailable
   * and the WebM fallback (or silent-audio fallback) is used, so the UI
   * can surface it instead of failing silently.
   */
  onMimeWarning?: (warning: string | null) => void;
  /** Override the default bitrate (bits/sec). Defaults: 8M vertical / 10M horiz. */
  videoBitsPerSecond?: number;
}

export const RENDER_FPS = 25;
/**
 * Legacy ffmpeg-era single-thread flag. Unused by the Canvas path —
 * kept so older imports don't break.
 */
export const RENDER_THREADS = 1;

/** Default bitrates for 1080p @ 25 fps (within the 8–10 Mbps budget). */
export const RENDER_VIDEO_BITS_VERTICAL = 8_000_000;
export const RENDER_VIDEO_BITS_HORIZONTAL = 10_000_000;

const DEFAULT_SCENE_DURATION = 5;
const MAX_CAPTION_LINES = 5;
const MAX_CAPTION_CHARS = 500;
const CAPTION_PAD_X = 48;
const CAPTION_PAD_Y = 24;

/* ------------------------- Pure / testable helpers ------------------------- */

/** Clamp a scene duration to [1, 30] s, defaulting to 5 s. Pure. */
export function clampDuration(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : NaN;
  if (Number.isNaN(n)) return DEFAULT_SCENE_DURATION;
  return Math.min(30, Math.max(1, Math.round(n)));
}

/**
 * Collapse whitespace, trim, and bound length. Pure. Unlike the legacy
 * `escapeDrawtext()` (which strips `'`, `:`, `%` for FFmpeg filter syntax),
 * Canvas text needs NO character escaping — unicode/emoji pass through to
 * fillText untouched.
 */
export function cleanCaptionText(value: unknown): string {
  const clean =
    typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return clean.slice(0, MAX_CAPTION_CHARS);
}

/** Caption point size: 64 px vertical (9:16) / 48 px horizontal (16:9). Pure. */
export function captionFontSize(width: number, height: number): number {
  return height >= width ? 64 : 48;
}

export interface CaptionLayout {
  fontSize: number;
  lineHeight: number;
  maxWidth: number;
  pad: number;
  padY: number;
  bottomMargin: number;
  font: string;
}

/** Geometry + font for a caption on a WxH frame. Pure (no canvas needed). */
export function captionLayout(width: number, height: number): CaptionLayout {
  const vertical = height >= width;
  const fontSize = vertical ? 64 : 48;
  const bottomMargin = vertical ? 300 : 150;
  const pad = CAPTION_PAD_X;
  return {
    fontSize,
    lineHeight: fontSize * 1.25,
    maxWidth: width - pad * 2 - 32,
    pad,
    padY: CAPTION_PAD_Y,
    bottomMargin,
    font:
      `bold ${fontSize}px system-ui, -apple-system, "Segoe UI", Arial, sans-serif`,
  };
}

/** Minimal measurer surface — real CanvasRenderingContext2D or a test double. */
export interface TextMeasurer {
  measureText(text: string): { width: number };
}

/**
 * Greedy word-wrap to `maxLines` lines within `maxWidth`. Pure given a
 * measurer (pass a real ctx or `{ measureText: (t) => ({ width: t.length * n }) }`
 * in tests). Handles: empty text → [], 200+ char paragraphs → hard-capped at
 * `maxLines` with a trailing "…" on overflow, single over-wide words →
 * character-broken so they never overflow the backdrop.
 */
export function wrapCaptionLines(
  measurer: TextMeasurer,
  text: string,
  maxWidth: number,
  maxLines: number = MAX_CAPTION_LINES,
): string[] {
  const cap = Math.max(1, Math.floor(maxLines));
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [];

  // Break any single word wider than maxWidth into fitting chunks so long
  // tokens (URLs, hashtags, CJK runs without spaces) can't overflow.
  const tokens: string[] = [];
  for (const word of words) {
    if (measurer.measureText(word).width <= maxWidth) {
      tokens.push(word);
      continue;
    }
    let chunk = "";
    for (const ch of word) {
      const trial = chunk + ch;
      if (
        chunk.length > 0 &&
        measurer.measureText(trial).width > maxWidth
      ) {
        tokens.push(chunk);
        chunk = ch;
      } else {
        chunk = trial;
      }
    }
    if (chunk.length > 0) tokens.push(chunk);
  }

  const lines: string[] = [];
  let current = "";
  let truncated = false;
  for (const token of tokens) {
    const trial = current.length > 0 ? `${current} ${token}` : token;
    if (measurer.measureText(trial).width <= maxWidth) {
      current = trial;
    } else {
      lines.push(current);
      current = token;
      if (lines.length >= cap) {
        truncated = true;
        current = "";
        break;
      }
    }
  }
  if (current.length > 0 && lines.length < cap) lines.push(current);
  else if (current.length > 0) truncated = true;
  const out = lines.slice(0, cap);
  if (truncated && out.length > 0) {
    // Signal continuation: append "…" keeping the last line within maxWidth.
    let last = out[out.length - 1];
    while (
      last.length > 1 &&
      measurer.measureText(`${last}…`).width > maxWidth
    ) {
      last = last.slice(0, -1);
    }
    out[out.length - 1] = `${last}…`;
  }
  return out;
}

export interface PickedMimeType {
  /** Full mime passed to MediaRecorder (may include codecs). */
  mimeType: string;
  /** Container type stamped on the output Blob (mime without codecs). */
  containerType: string;
  /** File extension matching the container: ".mp4" or ".webm". */
  extension: string;
  /** True when the browser records MP4 directly (no conversion needed). */
  isMp4: boolean;
  /** Non-null when falling back (surface to the user via onMimeWarning). */
  warning: string | null;
}

const MP4_MIME_CANDIDATES = [
  'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
  "video/mp4;codecs=avc1",
  "video/mp4",
];
const WEBM_FALLBACK_MIME = "video/webm;codecs=vp9";

/**
 * Pick the best MediaRecorder mime for MP4 output. Pure given a probe
 * (defaults to `MediaRecorder.isTypeSupported`, SSR-safe). Logs the winner
 * so the choice is auditable in the console.
 */
export function pickMp4MimeType(
  probe?: (mimeType: string) => boolean,
): PickedMimeType {
  const isSupported =
    probe ??
    ((mimeType: string): boolean => {
      try {
        return (
          typeof MediaRecorder !== "undefined" &&
          typeof MediaRecorder.isTypeSupported === "function" &&
          MediaRecorder.isTypeSupported(mimeType)
        );
      } catch {
        return false;
      }
    });
  for (const mimeType of MP4_MIME_CANDIDATES) {
    let ok = false;
    try {
      ok = isSupported(mimeType);
    } catch {
      ok = false;
    }
    if (ok) {
      // eslint-disable-next-line no-console
      console.info(`[render] MediaRecorder mime: ${mimeType} (MP4 direct)`);
      return {
        mimeType,
        containerType: "video/mp4",
        extension: ".mp4",
        isMp4: true,
        warning: null,
      };
    }
  }
  let webmOk = false;
  try {
    webmOk = isSupported(WEBM_FALLBACK_MIME);
  } catch {
    webmOk = false;
  }
  const warning =
    "MP4 recording is not supported in this browser (e.g. Firefox) — " +
    "the video was recorded as WebM instead. Open it in Chrome, Edge, " +
    "or Safari for an MP4.";
  // eslint-disable-next-line no-console
  console.info(
    `[render] MediaRecorder mime: ${webmOk ? WEBM_FALLBACK_MIME : "(browser default)"} (MP4 unavailable — fallback)`,
  );
  return {
    mimeType: webmOk ? WEBM_FALLBACK_MIME : "",
    containerType: "video/webm",
    extension: ".webm",
    isMp4: false,
    warning,
  };
}

/** Spec alias: `pickMimeType` === `pickMp4MimeType`. */
export const pickMimeType = pickMp4MimeType;

/** ".mp4" for MP4 containers, ".webm" otherwise. Pure. */
export function extensionForMimeType(mimeType: string): string {
  return mimeType.toLowerCase().includes("mp4") ? ".mp4" : ".webm";
}

/** Download filename matching the recorded container (`final.mp4` default). */
export function downloadFileNameForMimeType(
  mimeType: string,
  base = "final",
): string {
  return `${base}${extensionForMimeType(mimeType)}`;
}

/**
 * Exact Ken Burns variants from the old FfmpegService::renderClip ($idx % 4):
 * 0 zoom-in / 1 zoom-out / 2 pan-left @1.3x / 3 pan-right @1.3x.
 * Kept in filter-string form for back-compat; the Canvas path uses
 * kenBurnsRect() below (same variants, same ordering).
 */
export function kenBurnsFilterForIndex(
  index: number,
  frames: number,
  size: string,
): string {
  const safeFrames = Math.max(1, Math.floor(frames));
  switch (((index % 4) + 4) % 4) {
    case 0:
      return `zoompan=z='min(zoom+0.0015,1.5)':d=${safeFrames}:s=${size}:fps=${RENDER_FPS}`;
    case 1:
      return `zoompan=z='max(1.5-0.0015*on,1.0)':d=${safeFrames}:s=${size}:fps=${RENDER_FPS}`;
    case 2:
      return `zoompan=z=1.3:x='(iw-iw/zoom)*on/${safeFrames}':y='(ih-ih/zoom)/2':d=${safeFrames}:s=${size}:fps=${RENDER_FPS}`;
    default:
      return `zoompan=z=1.3:x='(iw-iw/zoom)*(1-on/${safeFrames})':y='(ih-ih/zoom)/2':d=${safeFrames}:s=${size}:fps=${RENDER_FPS}`;
  }
}

/**
 * Legacy backend-compatible drawtext escaping (FfmpegService::escapeDrawtext).
 * Kept for a future drawtext path — the Canvas path needs no escaping.
 */
export function escapeDrawtext(text: string): string {
  const clean = (text ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/[\\':%,]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean.slice(0, 200);
}

/**
 * TTS stub — always resolves null (silent scene), never blocks the render.
 * Kept for back-compat; the Canvas path prefers the WebAudio mux attempt
 * (see prepareSceneAudio) and falls back to silent the same way.
 */
export async function synthesizeSceneAudioStub(
  _narration: string,
): Promise<null> {
  return null;
}

/** True when the Canvas+MediaRecorder path can run (browser feature check). */
export function isCanvasMp4RenderSupported(): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return false;
  }
  try {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    const hasCapture =
      typeof canvas.captureStream === "function" &&
      typeof MediaRecorder !== "undefined";
    return !!ctx && hasCapture;
  } catch {
    return false;
  }
}

/* ------------------------- Canvas 2D text rendering ------------------------- */

function paintBackdrop(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const r = Math.min(28, h / 2);
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fill();
}

/**
 * Draw pre-wrapped caption lines bottom-center with a translucent backdrop,
 * black stroke + white fill per line. The caller MUST invoke this AFTER the
 * Ken Burns image draw on an identity transform so text stays locked
 * bottom-center (never zooming/panning with the image). Contrast on bright
 * images comes from the rgba(0,0,0,0.55) backdrop + stroke. No-op for [].
 */
export function drawCaptionLines(
  ctx: CanvasRenderingContext2D,
  lines: string[],
  width: number,
  height: number,
): void {
  if (lines.length === 0) return;
  const { fontSize, lineHeight, pad, padY, bottomMargin, font } =
    captionLayout(width, height);
  ctx.save();
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.lineJoin = "round";
  const blockH = lines.length * lineHeight;
  const baselineY = height - bottomMargin;
  paintBackdrop(ctx, pad / 2, baselineY - blockH - padY, width - pad, blockH + padY * 2);
  ctx.lineWidth = Math.max(4, fontSize / 10);
  ctx.strokeStyle = "black";
  ctx.fillStyle = "white";
  lines.forEach((line, i) => {
    const y = baselineY - (lines.length - 1 - i) * lineHeight;
    ctx.strokeText(line, width / 2, y);
    ctx.fillText(line, width / 2, y);
  });
  ctx.restore();
}

/**
 * Clean → wrap → draw a narration caption in one call. Returns the drawn
 * lines ([] when narration is empty/whitespace — nothing is painted).
 * Per-frame hot path wraps every call; prefer pre-wrapping with
 * wrapCaptionLines() once per scene + drawCaptionLines() per frame.
 */
export function drawCaption(
  ctx: CanvasRenderingContext2D,
  narration: string | null | undefined,
  width: number,
  height: number,
): string[] {
  const clean = cleanCaptionText(narration ?? "");
  if (clean.length === 0) return [];
  const { maxWidth, font } = captionLayout(width, height);
  ctx.save();
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.lineJoin = "round";
  const lines = wrapCaptionLines(ctx, clean, maxWidth, MAX_CAPTION_LINES);
  ctx.restore();
  drawCaptionLines(ctx, lines, width, height);
  return lines;
}

/* ------------------------- Ken Burns (Canvas) ------------------------- */

export interface KenBurnsRect {
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

/**
 * Canvas equivalent of kenBurnsFilterForIndex() (same `$idx % 4` variants):
 * cover-fit base scale, then 0: zoom-in 1.00→1.15, 1: zoom-out 1.15→1.00,
 * 2: pan 0→edge at 1.3x, 3: pan edge→0 at 1.3x. Pure — unit-testable.
 */
export function kenBurnsRect(
  index: number,
  progress: number,
  width: number,
  height: number,
  imgW: number,
  imgH: number,
): KenBurnsRect {
  const p = Math.min(1, Math.max(0, progress));
  const base = Math.max(width / imgW, height / imgH);
  const dw = imgW * base;
  const dh = imgH * base;
  const variant = ((index % 4) + 4) % 4;
  let z = 1;
  let dx = (width - dw) / 2;
  let dy = (height - dh) / 2;
  if (variant === 0) {
    z = 1 + 0.15 * p;
  } else if (variant === 1) {
    z = 1.15 - 0.15 * p;
  } else {
    z = 1.3;
    const minX = width - dw * z;
    // 2: pan 0 → minX · 3: pan minX → 0 (dy stays centered).
    dx = variant === 2 ? minX * p : minX * (1 - p);
    dy = (height - dh * z) / 2;
    return { dx, dy, dw: dw * z, dh: dh * z };
  }
  return { dx: (width - dw * z) / 2, dy: (height - dh * z) / 2, dw: dw * z, dh: dh * z };
}

/**
 * Paint one Ken Burns frame (cover-fit, full-bleed black base). MUST be
 * called BEFORE drawCaptionLines() each frame so captions stay locked.
 */
function drawKenBurnsFrame(
  ctx: CanvasRenderingContext2D,
  bitmap: ImageBitmap,
  index: number,
  progress: number,
  width: number,
  height: number,
): void {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  const r = kenBurnsRect(
    index,
    progress,
    width,
    height,
    bitmap.width,
    bitmap.height,
  );
  ctx.drawImage(bitmap, r.dx, r.dy, r.dw, r.dh);
  ctx.restore();
  // NOTE: transform is restored to identity here — drawCaptionLines() after
  // this call renders in screen space, locked bottom-center. Never draw text
  // inside the image transform above (it would zoom/pan with the photo).
}

/* ------------------------- Loading / audio helpers ------------------------- */

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new Error("Render cancelled. Tap Retry to run it again.");
}

async function decodeToBitmap(blob: Blob): Promise<ImageBitmap> {
  if (typeof createImageBitmap === "function") {
    return createImageBitmap(blob);
  }
  // Older Safari fallback: decode via <img> (blob: URL, CORS-safe).
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise<ImageBitmap>((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        createImageBitmap(img).then(resolve, reject);
      };
      img.onerror = () =>
        reject(new Error("Could not decode the scene image."));
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function loadSceneBitmap(
  imageUrl: string,
  sceneNo: number,
  count: number,
): Promise<ImageBitmap> {
  let response: Response;
  try {
    response = await fetch(imageUrl);
  } catch {
    throw new Error(
      `Render failed on scene ${sceneNo}/${count}: the scene image could ` +
        "not be downloaded (network/CORS). Re-generate that scene image, " +
        "then retry — other scenes are kept.",
    );
  }
  if (!response.ok) {
    throw new Error(
      `Render failed on scene ${sceneNo}/${count}: the scene image ` +
        `download failed (${response.status}). Re-generate that scene ` +
        "image, then retry — other scenes are kept.",
    );
  }
  try {
    return await decodeToBitmap(await response.blob());
  } catch {
    throw new Error(
      `Render failed on scene ${sceneNo}/${count}: the scene image could ` +
        "not be decoded. Re-generate that scene image, then retry — " +
        "other scenes are kept.",
    );
  }
}

interface PreparedSceneAudio {
  buffers: (AudioBuffer | null)[];
  context: AudioContext | null;
  destination: MediaStreamAudioDestinationNode | null;
}

/**
 * Best-effort WebAudio prep for optional TTS MP3s. Never throws — on any
 * failure returns an empty (silent) plan so audio can never kill a good
 * video (same guarantee the old ffmpeg `-shortest` mux gave).
 */
async function prepareSceneAudio(
  audioUrls: string[] | undefined,
): Promise<PreparedSceneAudio> {
  const silent: PreparedSceneAudio = {
    buffers: [],
    context: null,
    destination: null,
  };
  const urls = (audioUrls ?? []).filter(
    (u) => typeof u === "string" && u.trim().length > 0,
  );
  if (urls.length === 0 || typeof window === "undefined") return silent;
  try {
    const AC =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AC) return silent;
    const context = new AC();
    if (context.state === "suspended") {
      await context.resume().catch(() => undefined);
    }
    const destination = context.createMediaStreamDestination();
    const buffers = await Promise.all(
      urls.map(async (url): Promise<AudioBuffer | null> => {
        try {
          const res = await fetch(url);
          if (!res.ok) return null;
          const data = await res.arrayBuffer();
          return await context.decodeAudioData(data);
        } catch {
          return null;
        }
      }),
    );
    if (!buffers.some((b) => b !== null)) {
      await context.close().catch(() => undefined);
      return silent;
    }
    return { buffers, context, destination };
  } catch {
    return silent;
  }
}

function nextAnimationFrame(): Promise<number> {
  return new Promise<number>((resolve) => requestAnimationFrame(resolve));
}

/* ------------------------------ Assembly ------------------------------ */

/**
 * Assemble scenes into a single MP4 Blob (Canvas 2D + MediaRecorder).
 * Per-frame captions are drawn AFTER the Ken Burns transform (locked
 * bottom-center). Throws scene-indexed errors so the UI can show the scene
 * log + Retry without a rebuild. The Blob type is `video/mp4` on the MP4
 * path (verified below); on the Firefox fallback it is `video/webm` and
 * `onMimeWarning` fires so the UI can say so.
 */
export async function renderVideoClient(
  options: RenderVideoClientOptions,
): Promise<Blob> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new Error(
      "Rendering runs in the browser only. Open the app and retry.",
    );
  }
  const scenes = options.scenes ?? [];
  if (scenes.length === 0) {
    throw new Error(
      "No scenes to render. Generate the script and images first, then retry.",
    );
  }
  if (!isCanvasMp4RenderSupported()) {
    throw new Error(
      "Video recording is unavailable in this browser (Canvas capture or " +
        "MediaRecorder is missing). Try a recent Chrome, Edge, or Safari.",
    );
  }
  throwIfAborted(options.signal);

  const aspect = options.aspect ?? "1080x1920";
  const width = aspect === "1920x1080" ? 1920 : 1080;
  const height = aspect === "1920x1080" ? 1080 : 1920;
  const count = scenes.length;
  const durations = scenes.map((s) => clampDuration(s?.duration));
  const totalDuration = durations.reduce((a, b) => a + b, 0);

  const report = (p: number): void => {
    options.onProgress?.(Math.max(0, Math.min(100, Math.round(p))));
  };
  report(2);

  // 1. Decode all scene stills up-front (sequential — flat mobile memory).
  const bitmaps: ImageBitmap[] = [];
  try {
    for (let i = 0; i < count; i += 1) {
      throwIfAborted(options.signal);
      const url = (scenes[i]?.imageUrl ?? "").trim();
      if (url.length === 0) {
        throw new Error(
          `Render failed on scene ${i + 1}/${count}: that scene has no image. ` +
            "Generate images first, then tap Retry — other scenes are kept.",
        );
      }
      bitmaps.push(await loadSceneBitmap(url, i + 1, count));
      report(2 + Math.round((8 * (i + 1)) / count));
    }

    // 2. Pre-wrap captions ONCE per scene (measure cost paid here, not per
    // frame — this is what keeps the capture loop jank-free).
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx)
      throw new Error(
        "Canvas 2D is unavailable in this browser. Try Chrome, Edge, or Safari.",
      );
    const { font, maxWidth } = captionLayout(width, height);
    ctx.font = font;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    const sceneLines: string[][] = scenes.map((s) => {
      const clean = cleanCaptionText(s?.narration ?? "");
      if (clean.length === 0) return [];
      const wrapped = wrapCaptionLines(ctx, clean, maxWidth, MAX_CAPTION_LINES);
      if (wrapped.length > 0) return wrapped;
      // Measure-anomaly fallback (e.g. font not ready at wrap time): hard
      // split so a non-empty narration can NEVER silently vanish. The
      // per-frame draw re-wraps anyway via drawCaption fallback below.
      const hard: string[] = [];
      let cur = "";
      const pushCur = (): void => {
        // Char-chunk overlong no-space tokens so one long word can't
        // overflow the backdrop (mirrors wrapCaptionLines token breaking).
        while (cur.length > 42) {
          hard.push(cur.slice(0, 42));
          cur = cur.slice(42);
          if (hard.length >= MAX_CAPTION_LINES) {
            cur = "";
            return;
          }
        }
        if (cur) hard.push(cur);
        cur = "";
      };
      for (const word of clean.split(/\s+/).filter(Boolean)) {
        const trial = cur ? `${cur} ${word}` : word;
        if (trial.length <= 42) cur = trial;
        else {
          if (cur) pushCur();
          cur = word;
          if (hard.length >= MAX_CAPTION_LINES) break;
        }
      }
      if (cur && hard.length < MAX_CAPTION_LINES) pushCur();
      return hard.slice(0, MAX_CAPTION_LINES);
    });
    if (sceneLines.every((lines) => lines.length === 0)) {
      // eslint-disable-next-line no-console
      console.warn(
        "[render] all scenes have empty captions — check that narrations " +
          "reach renderVideoClient (scenes[].narration). Video will record " +
          "without burned-in text.",
      );
    }

    // 3. Mime selection (MP4 first, logged; WebM fallback warns the UI).
    const picked = pickMp4MimeType();
    if (picked.warning) options.onMimeWarning?.(picked.warning);
    else options.onMimeWarning?.(null);
    const videoBitsPerSecond =
      options.videoBitsPerSecond ??
      (aspect === "1920x1080"
        ? RENDER_VIDEO_BITS_HORIZONTAL
        : RENDER_VIDEO_BITS_VERTICAL);

    // 4. Capture stream (+ best-effort WebAudio scene audio).
    const captureStream = canvas.captureStream(RENDER_FPS);
    const audio = await prepareSceneAudio(options.audioUrls);
    if (
      (options.audioUrls ?? []).some(
        (u) => typeof u === "string" && u.trim().length > 0,
      ) &&
      !audio.destination
    ) {
      options.onMimeWarning?.(
        "Scene audio could not be attached in this browser — " +
          "the video was rendered silent. Pictures and captions are unaffected.",
      );
    }
    const recordStream =
      audio.destination &&
      audio.destination.stream.getAudioTracks().length > 0
        ? new MediaStream([
            ...captureStream.getVideoTracks(),
            ...audio.destination.stream.getAudioTracks(),
          ])
        : captureStream;

    let recorder: MediaRecorder;
    let effectiveContainer = picked.containerType;
    try {
      recorder = new MediaRecorder(
        recordStream,
        picked.mimeType
          ? { mimeType: picked.mimeType, videoBitsPerSecond }
          : { videoBitsPerSecond },
      );
    } catch {
      // Last resort: browser-default mime (still records playable video).
      try {
        recorder = new MediaRecorder(recordStream);
      } catch {
        throw new Error(
          "Video recording failed to start in this browser. " +
            "Try Chrome or Edge on desktop, then tap Retry.",
        );
      }
      options.onMimeWarning?.(
        "This browser refused the MP4 recorder settings — a default " +
          "recording was used instead. Playback still works in <video>.",
      );
    }
    try {
      const actual = recorder.mimeType ?? "";
      if (actual.length > 0) {
        effectiveContainer = actual.split(";")[0].trim() || effectiveContainer;
      }
    } catch {
      // Ignore — effectiveContainer already holds the picked value.
    }

    const chunks: Blob[] = [];
    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });
    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data && event.data.size > 0) chunks.push(event.data);
    };

    const liveSources: AudioBufferSourceNode[] = [];
    const stopAudio = (): void => {
      for (const src of liveSources) {
        try {
          src.stop();
        } catch {
          // Already ended — ignore.
        }
      }
      liveSources.length = 0;
    };

    try {
      // Paint the first AI-designated page BEFORE recorder.start() so the
      // capture stream already holds image + text on frame 0 (some browsers
      // drop the first ~100ms otherwise, which could eat the opening caption).
      drawKenBurnsFrame(ctx, bitmaps[0], 0, 0, width, height);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (sceneLines[0].length > 0) {
        drawCaptionLines(ctx, sceneLines[0], width, height);
      } else {
        drawCaption(ctx, scenes[0]?.narration ?? "", width, height);
      }
      recorder.start(250);
      report(10);
      const renderStart = performance.now();

      for (let i = 0; i < count; i += 1) {
        const sceneStart = performance.now();
        const duration = durations[i];
        // Start this scene's TTS (if any) in sync with its capture window.
        const buf = audio.buffers[i];
        if (buf && audio.context && audio.destination) {
          try {
            const src = audio.context.createBufferSource();
            src.buffer = buf;
            src.connect(audio.destination);
            src.start();
            liveSources.push(src);
          } catch {
            // Silent scene — video continues.
          }
        }
        for (;;) {
          throwIfAborted(options.signal);
          const elapsed = (performance.now() - sceneStart) / 1000;
          if (elapsed >= duration) break;
          const p = Math.min(1, elapsed / duration);
          // KEY ORDER on the SAME canvas: image (Ken Burns transform) FIRST,
          // then reset to identity and burn the caption AFTER — text stays
          // locked bottom-center on the AI-designated page, never zooming.
          drawKenBurnsFrame(ctx, bitmaps[i], i, p, width, height);
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          if (sceneLines[i].length > 0) {
            drawCaptionLines(ctx, sceneLines[i], width, height);
          } else {
            // Live re-wrap fallback (covers fonts loading after pre-wrap).
            drawCaption(ctx, scenes[i]?.narration ?? "", width, height);
          }
          const overall =
            (performance.now() - renderStart) / 1000 / totalDuration;
          report(10 + 85 * Math.min(1, Math.max(0, overall)));
          await nextAnimationFrame();
        }
      }

      recorder.stop();
      await stopped;
      report(96);
      stopAudio();

      const blob = new Blob(chunks, { type: effectiveContainer });
      if (blob.size === 0) {
        throw new Error(
          "Render produced an empty video file. Please tap Retry — " +
            "your scenes and images are kept.",
        );
      }
      if (picked.isMp4 && blob.type !== "video/mp4") {
        throw new Error(
          "Render finished but the output is not MP4. Try Chrome, Edge, " +
            "or Safari, then tap Retry — your scenes and images are kept.",
        );
      }
      report(100);
      return blob;
    } finally {
      stopAudio();
      try {
        if (recorder.state !== "inactive") recorder.stop();
      } catch {
        // Already stopped — ignore.
      }
      for (const track of recordStream.getTracks()) {
        try {
          track.stop();
        } catch {
          // Ignore — track already ended.
        }
      }
      if (audio.context) {
        await audio.context.close().catch(() => undefined);
      }
      canvas.width = 0;
      canvas.height = 0;
    }
  } finally {
    for (const bitmap of bitmaps) {
      try {
        if (typeof bitmap.close === "function") bitmap.close();
      } catch {
        // Ignore — decode-time resource already released.
      }
    }
  }
}
