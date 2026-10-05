"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  RATE_LIMIT_RETRY_SECONDS,
  SETTINGS_PATH,
  isRateLimitedMessage,
  isUnauthorizedMessage,
  isWasmLoadMessage,
} from "../lib/errors";

/**
 * Stage 6.3 — single consistent error surface for the whole frontend.
 *
 * - 401 invalid key  → message + "Open Settings" link (no dead-ends).
 * - 429 busy         → countdown + Retry; auto-calls `onRetry` at zero when
 *                      `autoRetry` is set (e.g. Cloudflare images, OpenRouter).
 * - engine start fail → engine hint (connection/browser support) + Retry.
 * - network/5xx/else → message + Retry button when `onRetry` is provided.
 * - Plain-text message render only (React escapes — XSS-safe).
 */

export interface ErrorAlertProps {
  message: string | null;
  /** Called by the Retry button (and by the auto-retry countdown at zero). */
  onRetry?: () => void;
  retryLabel?: string;
  /** Auto-retry when a 429/busy message is shown. Default: no auto-retry. */
  autoRetry?: boolean;
  /** Countdown length in seconds for 429 messages. */
  retrySeconds?: number;
}

const BUTTON_STYLE: React.CSSProperties = {
  minHeight: 44,
  minWidth: 44,
  padding: "10px 20px",
  borderRadius: 8,
  border: "1px solid #2A2A2A",
  background: "#1A1A1A",
  color: "#D4D4D4",
  fontSize: 16,
  cursor: "pointer",
};

const LINK_STYLE: React.CSSProperties = {
  color: "#D4D4D4",
  textDecoration: "underline",
};

export default function ErrorAlert({
  message,
  onRetry,
  retryLabel = "Retry",
  autoRetry = false,
  retrySeconds = RATE_LIMIT_RETRY_SECONDS,
}: ErrorAlertProps): React.ReactElement | null {
  const [countdown, setCountdown] = useState(retrySeconds);
  const firedRef = useRef(false);

  const rateLimited = message !== null && isRateLimitedMessage(message);
  const invalidKey = message !== null && isUnauthorizedMessage(message);
  const wasmLoadFail =
    message !== null &&
    !invalidKey &&
    !rateLimited &&
    isWasmLoadMessage(message);

  // Reset the countdown whenever a new error arrives.
  useEffect(() => {
    setCountdown(retrySeconds);
    firedRef.current = false;
  }, [message, retrySeconds]);

  // 429 countdown ticker; fires the auto-retry exactly once at zero.
  useEffect(() => {
    if (message === null || !rateLimited || !autoRetry) return;
    if (countdown <= 0) {
      if (onRetry && !firedRef.current) {
        firedRef.current = true;
        onRetry();
      }
      return;
    }
    const timer = setTimeout(() => setCountdown((prev) => prev - 1), 1000);
    return () => clearTimeout(timer);
  }, [message, rateLimited, autoRetry, countdown, onRetry]);

  if (message === null) return null;

  return (
    <div className="error-box" role="alert">
      <p style={{ margin: 0 }}>{message}</p>

      {invalidKey ? (
        <p style={{ margin: "8px 0 0" }}>
          <Link href={SETTINGS_PATH} style={LINK_STYLE}>
            Open Settings to update your key
          </Link>{" "}
          or create a new one at{" "}
          <a
            href="https://openrouter.ai/keys"
            target="_blank"
            rel="noreferrer"
            style={LINK_STYLE}
          >
            openrouter.ai/keys
          </a>
          .
        </p>
      ) : null}

      {rateLimited ? (
        <p role="status" style={{ margin: "8px 0 0" }}>
          {autoRetry && onRetry
            ? `Retrying automatically in ${countdown}s — nothing to re-enter.`
            : `You can retry in ${countdown}s — no need to re-enter anything.`}
        </p>
      ) : null}

      {wasmLoadFail ? (
        <p role="status" style={{ margin: "8px 0 0" }}>
          The video engine (Canvas + MediaRecorder) runs entirely in this tab —
          no download, no install. Keep the tab open and visible, use a recent
          Chrome, Edge, or Safari, then tap Retry. No
          reload of your images or script is needed.
        </p>
      ) : null}

      {onRetry ? (
        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={onRetry}
            disabled={rateLimited && countdown > 0 && autoRetry}
            style={{
              ...BUTTON_STYLE,
              opacity: rateLimited && countdown > 0 && autoRetry ? 0.6 : 1,
              cursor: rateLimited && countdown > 0 && autoRetry ? "not-allowed" : "pointer",
            }}
          >
            {rateLimited && autoRetry && countdown > 0 ? `Retry in ${countdown}s` : retryLabel}
          </button>
        </div>
      ) : null}
    </div>
  );
}
