/**
 * Vidiomaker Stage 6.3 — central user-facing error mapping.
 *
 * Every `catch` in the frontend should funnel through here so users always
 * see an actionable string instead of a bare status code:
 * - network failure  → retry hint (is the backend running?)
 * - 401 invalid key  → link to Settings (/settings) — rendered by ErrorAlert
 * - 429 busy         → auto-retry countdown — rendered by ErrorAlert
 * - 422 validation   → field-level hint (caller highlights the field)
 *
 * Plain strings only (no HTML) — React escapes them on render (XSS-safe).
 */

export const SETTINGS_PATH = "/settings";

/** Default wait before a 429 auto-retry (seconds). */
export const RATE_LIMIT_RETRY_SECONDS = 30;

export function isUnauthorizedMessage(message: string): boolean {
  return /401|invalid(\s+\w+)?\s+key|unauthorized|api key/i.test(message);
}

export function isRateLimitedMessage(message: string): boolean {
  return /429|rate.?limit|too many requests|busy|overloaded/i.test(message);
}

export function isValidationMessage(message: string): boolean {
  return /422|validation|invalid input/i.test(message);
}

export function isNotFoundMessage(message: string): boolean {
  return /404|not found/i.test(message);
}

/** True for fetch-level network failures (backend down, offline, CORS). */
export function isNetworkError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (error instanceof Error) {
    return /failed to fetch|networkerror|network request failed|fetch failed|load failed|econn|enotfound|socket/i.test(
      error.message
    );
  }
  return false;
}

export function networkErrorMessage(): string {
  return "Could not reach the service. Check your connection, then retry.";
}

export function unauthorizedErrorMessage(detail: string): string {
  return (
    detail ||
    "Invalid API key (401). Update your key in Settings (/settings) and try again."
  );
}

export function rateLimitedErrorMessage(detail: string): string {
  return (
    detail ||
    `Service is busy (429). Retrying automatically in ${RATE_LIMIT_RETRY_SECONDS}s — no need to re-enter anything.`
  );
}

export function validationErrorMessage(detail: string): string {
  return detail || "Invalid input (422). Please check the highlighted field and try again.";
}

/**
 * Map an HTTP status + backend `message` detail to a user-facing string.
 * Backend logic is untouched — this only shapes what the user reads.
 */
export function statusToUserMessage(status: number, detail: string): string {
  if (status === 401) return unauthorizedErrorMessage(detail);
  if (status === 429) return rateLimitedErrorMessage(detail);
  if (status === 422) return validationErrorMessage(detail);
  if (status === 404) {
    return detail || "Not found (404). It may have been deleted — please retry from the previous step.";
  }
  return detail || `Request failed (${status}). Please try again.`;
}

/**
 * Map any caught value to a user-facing string.
 * Network-level failures always become the retry hint, even when the
 * original error is a bare `TypeError: Failed to fetch`.
 */
export function toUserMessage(error: unknown, fallback: string): string {
  if (isNetworkError(error)) return networkErrorMessage();
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return fallback;
}

/**
 * Friendly per-scene Cloudflare Workers AI progress message.
 * Example: "Cloudflare timed out, retrying scene 2/5..."
 */
export function cloudflareSceneMessage(
  timedOut: boolean,
  sceneIdx?: number,
  sceneTotal?: number
): string {
  const verb = timedOut ? "timed out" : "is busy";
  if (typeof sceneIdx === "number" && typeof sceneTotal === "number") {
    return `Cloudflare ${verb}, retrying scene ${sceneIdx}/${sceneTotal}...`;
  }
  if (typeof sceneIdx === "number") {
    return `Cloudflare ${verb}, retrying scene ${sceneIdx}... Please wait a moment.`;
  }
  return "Cloudflare is busy. Please wait a moment and retry.";
}

/**
 * Client video-engine failure (Canvas 2D + MediaRecorder — no wasm download,
 * no COOP/COEP). Rendered through <ErrorAlert/> with Retry — never a blank error.
 */
export function isWasmLoadMessage(message: string): boolean {
  return /video engine.*(load|failed)|recording (failed|unavailable|could not start)|failed to load.*engine/i.test(
    message
  );
}

export function wasmLoadErrorMessage(detail: string): string {
  return (
    detail ||
    "Video engine failed to start (Canvas + MediaRecorder). Check your connection and tap Retry — no need to re-enter anything."
  );
}
