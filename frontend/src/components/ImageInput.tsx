"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { supabase } from "../lib/supabase";

// ---------------------------------------------------------------------------
// Stage 4 contract (pure frontend — no Laravel):
// - If a scene has a user-uploaded picture, the frontend sets
//   `scenes[idx].customImageUrl` to the uploaded file's storage path/URL.
// - `lib/images.ts generateAllSceneImages()` NEVER overwrites a scene whose
//   `image_url` already contains "uploads/" — Cloudflare generation is skipped
//   for that idx, and the uploaded object is referenced as-is. Helpers below
//   build that map:
//     getCustomImageByIdx(items) -> Record<sceneIdx, remotePath|remoteUrl>
//     getUploadedImageUrls(items) -> string[] (uploaded only, index-aligned)
// - Storage convention (see supabase/storage.md): bucket `uploads`,
//   object path `{videoId}/scene-{idx}.{ext}` (or `temp-{uuid}/...` when no
//   videoId exists yet). Generated AI stills live at
//   `{videoId}/scene-{idx}.jpg` (no item-id suffix, so they never collide
//   with custom uploads). RLS: `authenticated` insert/select; anonymous
//   visitors keep in-memory preview URLs instead (see lib/images.ts).
// ---------------------------------------------------------------------------

export type ImageItemStatus = "pending" | "uploading" | "uploaded" | "error";

export interface UploadedImageItem {
  id: string;
  file: File;
  /** Local blob preview URL (URL.createObjectURL). Revoked on remove/unmount. */
  preview: string;
  /** Storage object path inside the `uploads` bucket, e.g. `abc123/scene-0.jpg`. */
  remotePath?: string;
  /** Public/signed URL if resolvable; local `preview` is used for thumbnails. */
  remoteUrl?: string;
  status: ImageItemStatus;
  error?: string | null;
}

export interface ImageInputProps {
  value: UploadedImageItem[];
  onChange: (items: UploadedImageItem[]) => void;
  disabled?: boolean;
  /**
   * Supabase video id used for storage paths. When omitted, uploads go to
   * `temp-<uuid>/upload-<uuid>.<ext>` so files never collide.
   */
  videoId?: string;
  /** Max images accepted (scene count selector is 3-8). Defaults to 8. */
  maxFiles?: number;
}

const ACCEPTED_MIME = ["image/jpeg", "image/png"] as const;
const ACCEPT_ATTR = "image/jpeg,image/png,.jpg,.jpeg,.png";
const MAX_BYTES = 10 * 1024 * 1024;
const FRIENDLY_REJECT = "Each image must be JPG/PNG under 10MB.";
const BUCKET = "uploads";

const THEME = {
  background: "#000",
  text: "#B8B8B8",
  muted: "#808080",
  card: "#111",
  border: "#2A2A2A",
  button: "#1A1A1A",
  heading: "#D4D4D4",
} as const;

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function extFor(file: File): string {
  const nameExt = file.name.split(".").pop()?.toLowerCase();
  if (nameExt === "png") return "png";
  return "jpg";
}

function isAccepted(file: File): boolean {
  if ((ACCEPTED_MIME as readonly string[]).includes(file.type)) return true;
  const lower = file.name.toLowerCase();
  return lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".png");
}

/** Ordered list of uploaded remote paths/URLs, index-aligned with `items`. */
export function getUploadedImageUrls(items: UploadedImageItem[]): string[] {
  return items
    .filter((item) => item.status === "uploaded" && (item.remotePath || item.remoteUrl))
    .map((item) => (item.remotePath ?? item.remoteUrl) as string);
}

/**
 * Scene-index map for Stage 4: `customImageByIdx[idx] = remotePath`.
 * AI generation is skipped for every idx present in this map.
 */
export function getCustomImageByIdx(
  items: UploadedImageItem[]
): Record<number, string> {
  const map: Record<number, string> = {};
  items.forEach((item, idx) => {
    if (item.status === "uploaded" && (item.remotePath || item.remoteUrl)) {
      map[idx] = (item.remotePath ?? item.remoteUrl) as string;
    }
  });
  return map;
}

async function uploadOne(
  item: UploadedImageItem,
  sceneIdx: number,
  videoId: string | undefined
): Promise<{ remotePath: string; remoteUrl?: string }> {
  const ext = extFor(item.file);
  const folder = videoId && videoId.trim() !== "" ? videoId.trim() : `temp-${newId()}`;
  const objectPath = `${folder}/scene-${sceneIdx}-${item.id}.${ext}`;

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(objectPath, item.file, {
      contentType: item.file.type || (ext === "png" ? "image/png" : "image/jpeg"),
      upsert: true,
    });
  if (error) throw new Error(error.message);

  // Bucket is private per supabase/storage.md; the public URL may not
  // resolve — previews use the local blob `preview`, and scene matching
  // uses `remotePath` (contains "uploads/", skipped by lib/images.ts).
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(objectPath);
  return { remotePath: objectPath, remoteUrl: data?.publicUrl };
}

export default function ImageInput({
  value,
  onChange,
  disabled = false,
  videoId,
  maxFiles = 8,
}: ImageInputProps): React.ReactElement {
  const [dragActive, setDragActive] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dragCounter = useRef(0);
  const describedById = useId();
  const errorId = `${describedById}-error`;

  const itemsRef = useRef<UploadedImageItem[]>(value);
  itemsRef.current = value;
  const videoIdRef = useRef(videoId);
  videoIdRef.current = videoId;

  // Revoke blob previews on unmount (per-preview revoke happens on remove).
  useEffect(() => {
    const snapshot = itemsRef.current;
    return () => {
      for (const item of snapshot) {
        try {
          URL.revokeObjectURL(item.preview);
        } catch {
          // Preview may already be revoked on remove; safe to ignore.
        }
      }
    };
    // Intentionally run only on unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setStatus = useCallback(
    (id: string, patch: Partial<UploadedImageItem>) => {
      onChange(itemsRef.current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
    },
    [onChange]
  );

  const uploadItem = useCallback(
    async (item: UploadedImageItem, sceneIdx: number) => {
      setStatus(item.id, { status: "uploading", error: null });
      setGlobalError(null);
      try {
        const { remotePath, remoteUrl } = await uploadOne(
          { ...item, preview: item.preview },
          sceneIdx,
          videoIdRef.current
        );
        setStatus(item.id, { status: "uploaded", remotePath, remoteUrl, error: null });
      } catch (err) {
        const message =
          err instanceof Error && err.message
            ? `Upload failed (${err.message}). Check connection or Supabase env, then retry.`
            : "Upload failed. Check your connection, then retry.";
        setStatus(item.id, { status: "error", error: message });
      }
    },
    [setStatus]
  );

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      if (disabled) return;
      setGlobalError(null);
      const list = Array.from(files);
      if (list.length === 0) return;

      const room = Math.max(0, maxFiles - itemsRef.current.length);
      if (room <= 0) {
        setGlobalError(`You can upload up to ${maxFiles} images. Remove one to add another.`);
        return;
      }

      const accepted: UploadedImageItem[] = [];
      let rejected = false;
      for (const file of list.slice(0, room)) {
        if (!isAccepted(file) || file.size > MAX_BYTES || file.size === 0) {
          rejected = true;
          continue;
        }
        accepted.push({
          id: newId(),
          file,
          preview: URL.createObjectURL(file),
          status: "pending",
          error: null,
        });
      }
      if (list.length > room) rejected = true;
      if (rejected) setGlobalError(FRIENDLY_REJECT);
      if (accepted.length === 0) {
        if (!rejected) setGlobalError(FRIENDLY_REJECT);
        return;
      }

      const base = itemsRef.current;
      const next = [...base, ...accepted];
      onChange(next);
      // Fire uploads for the newly added items (index-aligned for Stage 4 map).
      accepted.forEach((item) => {
        const idx = next.findIndex((entry) => entry.id === item.id);
        void uploadItem(item, idx < 0 ? base.length : idx);
      });
    },
    [disabled, maxFiles, onChange, uploadItem]
  );

  const handleRemove = useCallback(
    (id: string) => {
      if (disabled) return;
      const target = itemsRef.current.find((item) => item.id === id);
      if (target) {
        try {
          URL.revokeObjectURL(target.preview);
        } catch {
          // Already revoked; ignore.
        }
      }
      onChange(itemsRef.current.filter((item) => item.id !== id));
    },
    [disabled, onChange]
  );

  const handleRetry = useCallback(
    (id: string) => {
      if (disabled) return;
      const idx = itemsRef.current.findIndex((item) => item.id === id);
      const target = itemsRef.current[idx];
      if (!target) return;
      void uploadItem(target, idx);
    },
    [disabled, uploadItem]
  );

  return (
    <section
      aria-label="Picture upload"
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
        Upload pictures (optional)
      </h2>
      <p id={describedById} style={{ color: THEME.muted, fontSize: 14, margin: "0 0 12px" }}>
        JPG/PNG only, up to 10MB each. Uploaded scenes skip AI image generation.
      </p>

      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        aria-describedby={describedById}
        aria-label="Upload images: drag files here or press Enter to browse"
        onClick={() => {
          if (!disabled) inputRef.current?.click();
        }}
        onKeyDown={(event) => {
          if (disabled) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragEnter={(event) => {
          if (disabled) return;
          event.preventDefault();
          dragCounter.current += 1;
          setDragActive(true);
        }}
        onDragOver={(event) => {
          if (disabled) return;
          event.preventDefault();
        }}
        onDragLeave={(event) => {
          if (disabled) return;
          event.preventDefault();
          dragCounter.current = Math.max(0, dragCounter.current - 1);
          if (dragCounter.current === 0) setDragActive(false);
        }}
        onDrop={(event) => {
          if (disabled) return;
          event.preventDefault();
          dragCounter.current = 0;
          setDragActive(false);
          if (event.dataTransfer?.files) addFiles(event.dataTransfer.files);
        }}
        style={{
          border: `2px dashed ${dragActive ? THEME.heading : THEME.border}`,
          borderRadius: 12,
          background: dragActive ? "#1E1E1E" : THEME.card,
          padding: 24,
          textAlign: "center",
          cursor: disabled ? "not-allowed" : "pointer",
          minHeight: 120,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          opacity: disabled ? 0.6 : 1,
        }}
      >
        <span style={{ fontSize: 16, color: THEME.heading }}>
          {dragActive ? "Drop images here" : "Drag & drop images, or tap to browse"}
        </span>
        <span style={{ fontSize: 13, color: THEME.muted }}>JPG/PNG, max 10MB each</span>
        <button
          type="button"
          disabled={disabled}
          onClick={(event) => {
            event.stopPropagation();
            inputRef.current?.click();
          }}
          style={{
            minHeight: 44,
            minWidth: 44,
            marginTop: 8,
            padding: "10px 20px",
            borderRadius: 8,
            border: `1px solid ${THEME.border}`,
            background: THEME.button,
            color: THEME.heading,
            fontSize: 16,
            cursor: disabled ? "not-allowed" : "pointer",
          }}
        >
          Browse files
        </button>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT_ATTR}
          multiple
          disabled={disabled}
          aria-label="Choose image files"
          onChange={(event) => {
            if (event.target.files) addFiles(event.target.files);
            // Reset so the same file can be picked again after remove.
            event.target.value = "";
          }}
          style={{ display: "none" }}
        />
      </div>

      {globalError ? (
        <div id={errorId} role="alert" className="error-box" style={{ marginTop: 12 }}>
          {globalError}
        </div>
      ) : null}

      {value.length > 0 ? (
        <ul
          aria-label="Uploaded image previews"
          style={{
            listStyle: "none",
            margin: "16px 0 0",
            padding: 0,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
            gap: 12,
          }}
        >
          {value.map((item, idx) => (
            <li
              key={item.id}
              style={{
                border: `1px solid ${THEME.border}`,
                borderRadius: 8,
                background: THEME.card,
                padding: 8,
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <img
                src={item.preview}
                alt={`Upload preview ${idx + 1}`}
                loading="lazy"
                style={{
                  width: "100%",
                  aspectRatio: "9 / 16",
                  objectFit: "cover",
                  borderRadius: 6,
                  display: "block",
                  background: "#000",
                }}
              />
              <span style={{ fontSize: 12, color: THEME.muted, wordBreak: "break-all" }}>
                Scene {idx + 1}
                {item.status === "uploaded" ? " · uploaded — AI image skipped" : ""}
                {item.status === "uploading" ? " · uploading…" : ""}
              </span>
              {item.status === "uploading" || item.status === "pending" ? (
                <span aria-live="polite" style={{ fontSize: 13, color: THEME.muted }}>
                  Uploading…
                </span>
              ) : null}
              {item.status === "error" && item.error ? (
                <div role="alert" style={{ fontSize: 13, color: "#D4A0A0" }}>
                  {item.error}
                </div>
              ) : null}
              <div style={{ display: "flex", gap: 8 }}>
                {item.status === "error" ? (
                  <button
                    type="button"
                    onClick={() => handleRetry(item.id)}
                    disabled={disabled}
                    aria-label={`Retry upload for scene ${idx + 1}`}
                    style={{
                      flex: 1,
                      minHeight: 44,
                      borderRadius: 8,
                      border: `1px solid ${THEME.border}`,
                      background: THEME.button,
                      color: THEME.heading,
                      fontSize: 14,
                      cursor: "pointer",
                    }}
                  >
                    Retry
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => handleRemove(item.id)}
                  disabled={disabled || item.status === "uploading"}
                  aria-label={`Remove image for scene ${idx + 1}`}
                  style={{
                    flex: 1,
                    minHeight: 44,
                    borderRadius: 8,
                    border: `1px solid ${THEME.border}`,
                    background: THEME.button,
                    color: THEME.text,
                    fontSize: 14,
                    cursor: "pointer",
                  }}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
