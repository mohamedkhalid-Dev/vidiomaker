"use client";

import { useCallback, useEffect, useState } from "react";
import {
  CLOUDFLARE_DEFAULT_STEPS,
  CLOUDFLARE_IMAGE_MODELS,
  CLOUDFLARE_MAX_STEPS,
  CLOUDFLARE_MIN_STEPS,
  normalizeImageSteps,
  readStoredImageSteps,
  storeImageSteps,
} from "../lib/cloudflare";
import { toUserMessage } from "../lib/errors";

const THEME = {
  background: "#000",
  text: "#B8B8B8",
  muted: "#808080",
  card: "#111",
  border: "#2A2A2A",
  button: "#1A1A1A",
  heading: "#D4D4D4",
} as const;

/**
 * Cloudflare Workers AI setup card (server credentials status).
 * The Account ID + API token live server-side only
 * (`frontend/.env.local`: CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN).
 * This card only reads GET /api/generate-image (no secrets) and shows
 * whether images will work + where to get the values.
 */
export default function SettingsCloudflare(): React.ReactElement {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [steps, setSteps] = useState<number>(CLOUDFLARE_DEFAULT_STEPS);
  const [stepsNote, setStepsNote] = useState<string | null>(null);

  const check = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      const res = await fetch("/api/generate-image");
      const payload = (await res.json().catch(() => null)) as {
        configured?: unknown;
      } | null;
      setConfigured(payload?.configured === true);
    } catch (err) {
      setConfigured(null);
      setError(
        toUserMessage(err, "Could not reach the image route. Retry.")
      );
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void check();
    try {
      setSteps(readStoredImageSteps());
    } catch {
      // Storage unavailable — default stands.
    }
  }, [check]);

  function handleStepsChange(next: number): void {
    const clean = normalizeImageSteps(next);
    setSteps(clean);
    try {
      storeImageSteps(clean);
      setStepsNote(`Saved — ${clean} step${clean === 1 ? "" : "s"} will be used for new pictures.`);
    } catch {
      setStepsNote(`Using ${clean} steps for this session (could not save).`);
    }
  }

  function handleStepsReset(): void {
    handleStepsChange(CLOUDFLARE_DEFAULT_STEPS);
  }

  return (
    <section
      aria-label="Cloudflare Workers AI image settings"
      style={{
        background: THEME.background,
        color: THEME.text,
        border: `1px solid ${THEME.border}`,
        borderRadius: 12,
        padding: 16,
        width: "100%",
        maxWidth: 720,
      }}
    >
      <h2 style={{ color: THEME.heading, margin: "0 0 8px", fontSize: 20 }}>
        Images{" "}
        <span
          role="status"
          aria-live="polite"
          style={{
            fontSize: 13,
            fontWeight: 400,
            border: `1px solid ${THEME.border}`,
            borderRadius: 999,
            padding: "2px 10px",
            marginLeft: 8,
            whiteSpace: "nowrap",
          }}
        >
          {checking ? "… Checking" : configured === true ? "● Ready" : configured === false ? "○ Not configured" : "○ Unknown"}
        </span>
      </h2>
      <p style={{ color: THEME.muted, margin: "0 0 12px", fontSize: 14, lineHeight: 1.6 }} aria-live="polite">
        {checking
          ? "Checking server configuration…"
          : configured === true
            ? "Image generation will work. Pick the model on Create → Images."
            : configured === false
              ? "Add the two server values below, then restart."
              : "Could not check status — press Recheck."}
      </p>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
        <button
          type="button"
          onClick={() => void check()}
          disabled={checking}
          style={{
            minHeight: 44,
            padding: "10px 20px",
            borderRadius: 8,
            border: `1px solid ${THEME.border}`,
            background: THEME.button,
            color: THEME.heading,
            fontSize: 16,
            cursor: checking ? "not-allowed" : "pointer",
            opacity: checking ? 0.6 : 1,
          }}
        >
          {checking ? "Checking…" : "Recheck status"}
        </button>
      </div>

      {error ? (
        <p role="alert" style={{ color: "#D4A0A0", fontSize: 14 }}>{error}</p>
      ) : null}

      <div
        style={{
          marginTop: 12,
          background: THEME.card,
          border: `1px solid ${THEME.border}`,
          borderRadius: 8,
          padding: "12px 14px",
          display: "grid",
          gap: 8,
        }}
      >
        <label htmlFor="cloudflare-steps" style={{ fontSize: 14, color: THEME.heading }}>
          Generation steps: <strong>{steps}</strong> (default {CLOUDFLARE_DEFAULT_STEPS})
        </label>
        <input
          id="cloudflare-steps"
          type="range"
          min={CLOUDFLARE_MIN_STEPS}
          max={CLOUDFLARE_MAX_STEPS}
          step={1}
          value={steps}
          onChange={(event) => handleStepsChange(Number(event.target.value))}
          aria-describedby="cloudflare-steps-help"
          style={{ width: "100%", minHeight: 44, accentColor: "#D4D4D4" }}
        />
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <label htmlFor="cloudflare-steps-number" style={{ fontSize: 13, color: THEME.muted }}>
            Steps ({CLOUDFLARE_MIN_STEPS}–{CLOUDFLARE_MAX_STEPS})
          </label>
          <input
            id="cloudflare-steps-number"
            type="number"
            min={CLOUDFLARE_MIN_STEPS}
            max={CLOUDFLARE_MAX_STEPS}
            step={1}
            value={steps}
            onChange={(event) => handleStepsChange(Number(event.target.value))}
            style={{
              width: 88,
              minHeight: 44,
              padding: "8px 10px",
              borderRadius: 8,
              border: `1px solid ${THEME.border}`,
              background: THEME.background,
              color: THEME.text,
              fontSize: 16,
            }}
          />
          <button
            type="button"
            onClick={handleStepsReset}
            disabled={steps === CLOUDFLARE_DEFAULT_STEPS}
            style={{
              minHeight: 44,
              padding: "10px 16px",
              borderRadius: 8,
              border: `1px solid ${THEME.border}`,
              background: THEME.button,
              color: THEME.heading,
              fontSize: 14,
              cursor: steps === CLOUDFLARE_DEFAULT_STEPS ? "not-allowed" : "pointer",
              opacity: steps === CLOUDFLARE_DEFAULT_STEPS ? 0.6 : 1,
            }}
          >
            Reset to {CLOUDFLARE_DEFAULT_STEPS}
          </button>
        </div>
        <p id="cloudflare-steps-help" style={{ color: THEME.muted, margin: 0, fontSize: 13, lineHeight: 1.5 }}>
          More steps = more detail but slower. Applies to FLUX.1 Schnell and
          FLUX.2 Dev; Klein models stay fixed at 4 steps. Saved in this browser
          and used for every new picture.
        </p>
        {stepsNote ? (
          <p role="status" style={{ color: THEME.muted, margin: 0, fontSize: 13 }}>{stepsNote}</p>
        ) : null}
      </div>

      <details>
        <summary style={{ minHeight: 44, display: "inline-flex", alignItems: "center", cursor: "pointer", fontSize: 14 }}>
          Advanced setup (Account ID, token, models)
        </summary>

      <ol style={{ color: THEME.text, fontSize: 14, lineHeight: 1.7, margin: "0 0 12px", paddingLeft: 20 }}>
        <li>
          Sign up / sign in at{" "}
          <a
            href="https://dash.cloudflare.com/?to=/:account/ai/workers-ai"
            target="_blank"
            rel="noreferrer"
            style={{ color: THEME.heading, textDecoration: "underline" }}
          >
            dash.cloudflare.com → Workers AI
          </a>{" "}
          → <strong>Use REST API</strong> →{" "}
          <strong>Create a Workers AI API Token</strong> (template already has
          Workers AI Read + Edit) → copy the token.
        </li>
        <li>
          On the same page copy your <strong>Account ID</strong> (32-char hex,
          also in the dashboard sidebar).
        </li>
        <li>
          In <code>frontend/.env.local</code> add (server-only — never{" "}
          <code>NEXT_PUBLIC_</code>):
          <pre
            style={{
              background: THEME.card,
              border: `1px solid ${THEME.border}`,
              borderRadius: 8,
              padding: "10px 12px",
              overflowX: "auto",
              fontSize: 13,
              marginTop: 8,
            }}
          >
{`CLOUDFLARE_ACCOUNT_ID=your-32-char-account-id
CLOUDFLARE_API_TOKEN=your-workers-ai-token`}
          </pre>
        </li>
        <li>
          Restart (<code>npm run dev</code>) or redeploy on Vercel (add the
          same two vars in Project → Settings → Environment Variables).
        </li>
      </ol>

      <p style={{ color: THEME.muted, margin: "0 0 12px", fontSize: 14, lineHeight: 1.6 }}>
        Pick the model on the Create page → Images step (choice is saved in
        this browser):
      </p>
      <ul style={{ margin: "0 0 4px", paddingLeft: 20, fontSize: 14, lineHeight: 1.7 }}>
        {CLOUDFLARE_IMAGE_MODELS.map((m) => (
          <li key={m.id} style={{ wordBreak: "break-all" }}>
            <strong style={{ color: THEME.heading }}>{m.label}</strong>
            <br />
            <code>{m.id}</code> — {m.hint}
          </li>
        ))}
      </ul>
      </details>
    </section>
  );
}
