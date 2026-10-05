"use client";

/**
 * Vidiomaker — direct-from-browser image library uploader.
 *
 * Flow (no backend hop, no secrets in the browser bundle):
 *   1. Pick a file via <input id="imageInput"> (JPG/PNG/WebP, ≤10MB).
 *   2. Client validation runs on select AND right before upload.
 *   3. Upload bytes straight to Supabase Storage bucket `images` at
 *      `public/${Date.now()}_${file.name}` (sanitized) with
 *      `{ contentType, cacheControl: "3600" }`.
 *   4. Resolve the public URL via getPublicUrl, then insert one row into
 *      the `images` table: `{ url, name, description }`
 *      (+ file_path / size_bytes / mime_type for ops).
 *
 * Env (browser-safe, NEXT_PUBLIC_ prefix required — see .env.example):
 *   NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY,
 *   read in lib/supabase.ts. Missing env → friendly message, no throw.
 *
 * Notes:
 * - supabase-js v2 Storage upload exposes no progress callback, so progress
 *   is an honest indeterminate state ("Uploading…") via aria-live — no fake
 *   percentage bar. Inputs + button are disabled while uploading.
 * - User text (file name, description) renders as plain text only — React
 *   escapes it by default; never dangerouslySetInnerHTML here.
 * - Black #000 + grey #B8B8B8 theme, fluid layout (works at 360px wide).
 */

import { useEffect, useId, useRef, useState } from "react";
import { toUserMessage } from "../lib/errors";
import { isSupabaseConfigured, supabase } from "../lib/supabase";
import {
  IMAGE_LIBRARY_ACCEPT_ATTR,
  IMAGE_LIBRARY_BUCKET,
  IMAGE_LIBRARY_MAX_DESCRIPTION,
  buildLibraryStoragePath,
  mapLibraryUploadError,
  validateLibraryFile,
} from "../lib/imageUpload";

export interface LibraryImageRow {
  url: string;
  name: string;
  description: string | null;
}

export interface ImageLibraryUploaderProps {
  /** Called with the saved row after a successful upload + insert. */
  onUploaded?: (row: LibraryImageRow) => void;
  disabled?: boolean;
}

type UploadStatus = "idle" | "uploading" | "success" | "error";

const THEME = {
  background: "#000",
  text: "#B8B8B8",
  muted: "#808080",
  card: "#111",
  border: "#2A2A2A",
  button: "#1A1A1A",
  heading: "#D4D4D4",
} as const;

const UPLOAD_FALLBACK =
  "Could not upload the image. Check your connection, then retry.";

export default function ImageLibraryUploader({
  onUploaded,
  disabled = false,
}: ImageLibraryUploaderProps): React.ReactElement {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<UploadStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [uploadedUrl, setUploadedUrl] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const helpId = useId();
  const errorId = `${helpId}-error`;
  const statusId = `${helpId}-status`;
  const busy = status === "uploading" || disabled;

  // Revoke the blob preview when it is replaced or on unmount.
  useEffect(() => {
    return () => {
      if (preview) {
        try {
          URL.revokeObjectURL(preview);
        } catch {
          // Already revoked; safe to ignore.
        }
      }
    };
  }, [preview]);

  function setPreviewFor(next: File | null): void {
    setPreview((current) => {
      if (current) {
        try {
          URL.revokeObjectURL(current);
        } catch {
          // Already revoked; safe to ignore.
        }
      }
      return next ? URL.createObjectURL(next) : null;
    });
  }

  function handleSelect(files: FileList | null): void {
    if (disabled || status === "uploading") return;
    setError(null);
    setUploadedUrl(null);
    if (!files || files.length === 0) return;
    const picked = files[0];
    const validationError = validateLibraryFile(picked);
    if (validationError) {
      setFile(null);
      setPreviewFor(null);
      setStatus("error");
      setError(validationError);
      return;
    }
    setFile(picked);
    setPreviewFor(picked);
    setStatus("idle");
  }

  function handleClear(): void {
    if (status === "uploading") return;
    setFile(null);
    setPreviewFor(null);
    setDescription("");
    setError(null);
    setUploadedUrl(null);
    setStatus("idle");
    if (inputRef.current) inputRef.current.value = "";
  }

  async function handleUpload(): Promise<void> {
    if (disabled || status === "uploading") return;
    setError(null);
    setUploadedUrl(null);

    if (!isSupabaseConfigured()) {
      setStatus("error");
      setError(
        "Image service is not configured. Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY, then retry."
      );
      return;
    }
    const validationError = validateLibraryFile(file);
    if (validationError || !file) {
      setStatus("error");
      setError(validationError ?? "Choose an image first — JPG, PNG, or WebP up to 10MB.");
      return;
    }
    const cleanDescription = description.trim().slice(0, IMAGE_LIBRARY_MAX_DESCRIPTION);

    setStatus("uploading");
    const selected = file;
    try {
      const storagePath = buildLibraryStoragePath(selected.name);
      const { error: uploadError } = await supabase.storage
        .from(IMAGE_LIBRARY_BUCKET)
        .upload(storagePath, selected, {
          contentType: selected.type,
          cacheControl: "3600",
        });
      if (uploadError) {
        throw new Error(uploadError.message);
      }

      const { data: urlData } = supabase.storage
        .from(IMAGE_LIBRARY_BUCKET)
        .getPublicUrl(storagePath);
      const publicUrl = urlData?.publicUrl ?? "";
      if (publicUrl.length === 0) {
        throw new Error("Upload finished but no public URL was returned.");
      }

      const row: LibraryImageRow = {
        url: publicUrl,
        name: selected.name,
        description: cleanDescription.length > 0 ? cleanDescription : null,
      };
      const { error: dbError } = await supabase.from("images").insert({
        url: row.url,
        name: row.name,
        description: row.description,
        file_path: storagePath,
        size_bytes: selected.size,
        mime_type: selected.type,
      });
      if (dbError) {
        throw new Error(
          `Image uploaded, but saving to the library failed (${dbError.message}). The file is in storage — please retry saving.`
        );
      }

      setUploadedUrl(publicUrl);
      setStatus("success");
      onUploaded?.(row);
    } catch (err) {
      setStatus("error");
      setError(mapLibraryUploadError(err instanceof Error ? err.message : "", toUserMessage(err, UPLOAD_FALLBACK)));
    }
  }

  return (
    <section
      aria-label="Image library upload"
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
        Add to image library
      </h2>
      <p id={helpId} style={{ color: THEME.muted, fontSize: 14, margin: "0 0 12px" }}>
        JPG, PNG, or WebP up to 10MB. Uploads go straight from your browser to
        Supabase Storage.
      </p>

      <div style={{ display: "grid", gap: 12 }}>
        <div>
          <label
            htmlFor="imageInput"
            style={{ display: "block", color: THEME.heading, fontSize: 14, marginBottom: 6 }}
          >
            Choose image
          </label>
          <input
            id="imageInput"
            ref={inputRef}
            type="file"
            accept={IMAGE_LIBRARY_ACCEPT_ATTR}
            disabled={busy}
            aria-describedby={helpId}
            onChange={(event) => {
              handleSelect(event.target.files);
              // Reset so the same file can be picked again after clear.
              event.target.value = "";
            }}
            style={{
              width: "100%",
              minHeight: 44,
              padding: "10px 12px",
              borderRadius: 8,
              border: `1px solid ${THEME.border}`,
              background: THEME.card,
              color: THEME.text,
              fontSize: 16,
            }}
          />
        </div>

        {preview && file ? (
          <figure style={{ margin: 0, display: "grid", gap: 8 }}>
            <img
              src={preview}
              alt={`Preview of ${file.name}`}
              loading="lazy"
              style={{
                width: "100%",
                maxHeight: 320,
                objectFit: "contain",
                borderRadius: 8,
                border: `1px solid ${THEME.border}`,
                background: "#000",
                display: "block",
              }}
            />
            <figcaption
              style={{ fontSize: 13, color: THEME.muted, overflowWrap: "anywhere" }}
            >
              {file.name} · {(file.size / (1024 * 1024)).toFixed(2)}MB
            </figcaption>
          </figure>
        ) : null}

        <div>
          <label
            htmlFor={`${helpId}-description`}
            style={{ display: "block", color: THEME.heading, fontSize: 14, marginBottom: 6 }}
          >
            Description (optional)
          </label>
          <input
            id={`${helpId}-description`}
            type="text"
            value={description}
            disabled={busy}
            maxLength={IMAGE_LIBRARY_MAX_DESCRIPTION}
            placeholder="e.g. hero shot for the cave scene"
            onChange={(event) => setDescription(event.target.value)}
            style={{
              width: "100%",
              minHeight: 44,
              padding: "10px 12px",
              borderRadius: 8,
              border: `1px solid ${THEME.border}`,
              background: THEME.card,
              color: THEME.heading,
              fontSize: 16,
            }}
          />
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={() => void handleUpload()}
            disabled={busy || !file}
            aria-describedby={statusId}
            style={{
              flex: "1 1 200px",
              minHeight: 48,
              padding: "10px 20px",
              borderRadius: 8,
              border: "1px solid #E8E8E8",
              background: "#E8E8E8",
              color: "#000",
              fontSize: 16,
              fontWeight: 700,
              cursor: busy || !file ? "not-allowed" : "pointer",
              opacity: busy || !file ? 0.6 : 1,
            }}
          >
            {status === "uploading" ? "Uploading…" : "Upload image"}
          </button>
          {file || description || uploadedUrl ? (
            <button
              type="button"
              onClick={handleClear}
              disabled={status === "uploading"}
              style={{
                minHeight: 48,
                padding: "10px 20px",
                borderRadius: 8,
                border: `1px solid ${THEME.border}`,
                background: THEME.button,
                color: THEME.heading,
                fontSize: 16,
                cursor: status === "uploading" ? "not-allowed" : "pointer",
              }}
            >
              Clear
            </button>
          ) : null}
        </div>

        <p id={statusId} role="status" aria-live="polite" style={{ margin: 0, fontSize: 14, color: THEME.muted }}>
          {status === "uploading"
            ? "Uploading… keep this tab open."
            : status === "success"
              ? "Image saved to your library."
              : file
                ? "Ready to upload."
                : "No image selected yet."}
        </p>

        {error ? (
          <div id={errorId} role="alert" className="error-box" style={{ margin: 0 }}>
            {error}
          </div>
        ) : null}

        {status === "success" && uploadedUrl ? (
          <p style={{ margin: 0, fontSize: 13, color: THEME.muted, overflowWrap: "anywhere" }}>
            Saved: {uploadedUrl}
          </p>
        ) : null}
      </div>
    </section>
  );
}
