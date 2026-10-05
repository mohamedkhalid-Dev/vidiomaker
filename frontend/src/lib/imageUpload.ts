/**
 * Vidiomaker — shared client-side validation for the image library uploader.
 *
 * Pure helpers only (no Supabase import, no React): `ImageLibraryUploader`
 * owns the storage + DB calls, these functions own the rules so the same
 * messages stay consistent everywhere (DRY). Plain strings only — React
 * escapes them on render (XSS-safe, never bare status codes).
 */

/** Storage bucket for the general image library (see component). */
export const IMAGE_LIBRARY_BUCKET = "images";

/** Max accepted file size: 10 MB. */
export const IMAGE_LIBRARY_MAX_BYTES = 10 * 1024 * 1024;

/** Accepted MIME types for the library uploader. */
export const IMAGE_LIBRARY_ACCEPTED_MIME = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

/** Value for the file input's `accept` attribute. */
export const IMAGE_LIBRARY_ACCEPT_ATTR = "image/jpeg,image/png,image/webp";

/** Max description length stored in `images.description`. */
export const IMAGE_LIBRARY_MAX_DESCRIPTION = 280;

/**
 * Strip path components + unsafe characters so the name is safe inside a
 * Storage object key. Keeps letters, digits, dot, dash, underscore.
 */
export function sanitizeLibraryFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "image";
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/_+/g, "_");
  const trimmed = cleaned.replace(/^[._]+/, "").slice(0, 120);
  return trimmed.length > 0 ? trimmed : "image";
}

/**
 * Storage object key for a library upload, per spec:
 * `public/${Date.now()}_${file.name}` (name sanitized).
 */
export function buildLibraryStoragePath(
  fileName: string,
  now: number = Date.now()
): string {
  return `public/${now}_${sanitizeLibraryFileName(fileName)}`;
}

/** True when the file looks like an accepted image (MIME + extension fallback). */
export function isAcceptedLibraryFile(file: File): boolean {
  if (
    (IMAGE_LIBRARY_ACCEPTED_MIME as readonly string[]).includes(file.type)
  ) {
    return true;
  }
  const lower = file.name.toLowerCase();
  return (
    lower.endsWith(".jpg") ||
    lower.endsWith(".jpeg") ||
    lower.endsWith(".png") ||
    lower.endsWith(".webp")
  );
}

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Validate a candidate file. Returns a friendly error message, or null when
 * the file is acceptable. Call on select AND right before upload (the File
 * object could be stale).
 */
export function validateLibraryFile(file: File | null): string | null {
  if (!file) {
    return "Choose an image first — JPG, PNG, or WebP up to 10MB.";
  }
  if (file.size === 0) {
    return "That file looks empty (0 bytes). Please choose a different image.";
  }
  if (!isAcceptedLibraryFile(file)) {
    return "That file type is not supported. Please choose a JPG, PNG, or WebP image.";
  }
  if (file.size > IMAGE_LIBRARY_MAX_BYTES) {
    return `That image is ${megabytes(file.size)} — please choose one under 10MB.`;
  }
  return null;
}

/**
 * Map a Storage/DB failure to a friendly message (never a bare code).
 * `fallback` covers network-level failures; pass the result of
 * `toUserMessage()` from lib/errors when available.
 */
export function mapLibraryUploadError(message: string, fallback: string): string {
  const detail = message.trim();
  if (/bucket not found|bucket .* does not exist|404/i.test(detail)) {
    return "Image storage is not ready (bucket “images” is missing). Please try again later or ask an admin to create it.";
  }
  if (/row-level security|rls|not authorized|permission|unauthorized|401|403/i.test(detail)) {
    return "Upload was blocked by permissions. Sign in if required, then retry.";
  }
  if (/duplicate|already exists|409/i.test(detail)) {
    return "That image name was just used. Please retry — the uploader makes each name unique.";
  }
  if (/payload too large|too large|exceeded|413/i.test(detail)) {
    return "That image is too large for the server. Please choose one under 10MB and retry.";
  }
  if (/failed to fetch|network|fetch failed|load failed/i.test(detail)) {
    return fallback;
  }
  if (detail.length > 0) {
    return `Could not upload the image (${detail}). Check your connection, then retry.`;
  }
  return fallback;
}
