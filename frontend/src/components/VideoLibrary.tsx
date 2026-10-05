"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isSupabaseConfigured } from "../lib/supabase";
import { toUserMessage } from "../lib/errors";
import {
  MAX_VIDEO_BYTES,
  deleteBrowserVideo,
  listBrowserVideos,
  uploadBrowserVideo,
  type BrowserVideo,
} from "../lib/videoStorage";
import ErrorAlert from "./ErrorAlert";

/**
 * Browser-only video library (no backend).
 * Upload → Supabase Storage bucket `videos` → public URL → row in
 * `public.videos` (title, URL, description). Download + Delete anytime.
 */

function formatDate(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function VideoLibrary(): React.ReactElement {
  const [videos, setVideos] = useState<BrowserVideo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [itemErrors, setItemErrors] = useState<Record<string, string>>({});
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setVideos(await listBrowserVideos());
    } catch (err) {
      setError(toUserMessage(err, "Could not load videos. Please retry."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isSupabaseConfigured()) {
      setLoading(false);
      setError(
        "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY in frontend/.env.local, then reload."
      );
      return;
    }
    void load();
  }, [load]);

  const handleUpload = useCallback(async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setUploadError("Please choose a video file first.");
      return;
    }
    setUploading(true);
    setUploadError(null);
    try {
      const record = await uploadBrowserVideo(file, { title, description });
      setVideos((prev) => [record, ...prev]);
      setTitle("");
      setDescription("");
      if (fileRef.current) fileRef.current.value = "";
    } catch (err) {
      setUploadError(toUserMessage(err, "Upload failed. Please retry."));
    } finally {
      setUploading(false);
    }
  }, [title, description]);

  const handleDelete = useCallback(async (video: BrowserVideo) => {
    if (
      typeof window !== "undefined" &&
      !window.confirm(`Delete "${video.title || video.file_name || "video"}"? This cannot be undone.`)
    ) {
      return;
    }
    setDeletingId(video.id);
    try {
      await deleteBrowserVideo(video.id, video.storage_path);
      setVideos((prev) => prev.filter((item) => item.id !== video.id));
    } catch (err) {
      setItemErrors((prev) => ({
        ...prev,
        [video.id]: toUserMessage(err, "Could not delete this video. Please retry."),
      }));
    } finally {
      setDeletingId(null);
    }
  }, []);

  return (
    <section aria-label="Video library" style={{ display: "grid", gap: 16 }}>
      <div
        className="card"
        style={{ display: "grid", gap: 12, padding: 16 }}
      >
        <h2 style={{ color: "#D4D4D4", margin: 0, fontSize: 18 }}>
          Upload a video
        </h2>
        <p style={{ color: "#808080", margin: 0, fontSize: 14, lineHeight: 1.6 }}>
          Saved straight to Supabase Storage (bucket{" "}
          <code>videos</code>) from your browser — no backend. Max{" "}
          {Math.round(MAX_VIDEO_BYTES / (1024 * 1024))} MB per file.
        </p>
        <label
          htmlFor="videoInput"
          style={{ color: "#B8B8B8", fontSize: 14, display: "grid", gap: 6 }}
        >
          Video file
          <input
            id="videoInput"
            ref={fileRef}
            type="file"
            accept="video/*"
            aria-label="Choose a video file"
            style={{ color: "#B8B8B8", minHeight: 44 }}
          />
        </label>
        <label style={{ color: "#B8B8B8", fontSize: 14, display: "grid", gap: 6 }}>
          Title (optional — defaults to file name)
          <input
            type="text"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="My holiday clip"
            maxLength={120}
            aria-label="Video title"
            style={{
              background: "#111",
              color: "#D4D4D4",
              border: "1px solid #2A2A2A",
              borderRadius: 8,
              padding: "10px 12px",
              minHeight: 44,
            }}
          />
        </label>
        <label style={{ color: "#B8B8B8", fontSize: 14, display: "grid", gap: 6 }}>
          Description (optional)
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Where / when was this taken?"
            maxLength={500}
            rows={2}
            aria-label="Video description"
            style={{
              background: "#111",
              color: "#D4D4D4",
              border: "1px solid #2A2A2A",
              borderRadius: 8,
              padding: "10px 12px",
              resize: "vertical",
            }}
          />
        </label>
        {uploadError ? <ErrorAlert message={uploadError} /> : null}
        <div>
          <button
            type="button"
            className="button vm-btn-primary"
            onClick={() => void handleUpload()}
            disabled={uploading}
            style={{ minHeight: 44 }}
          >
            {uploading ? "Uploading…" : "Upload video"}
          </button>
        </div>
      </div>

      <div style={{ display: "grid", gap: 12 }}>
        <h2 style={{ color: "#D4D4D4", margin: 0, fontSize: 18 }}>
          Saved videos ({videos.length})
        </h2>
        {loading ? (
          <p role="status" style={{ color: "#808080" }}>
            Loading videos…
          </p>
        ) : error ? (
          <ErrorAlert message={error} onRetry={() => void load()} retryLabel="Reload videos" />
        ) : videos.length === 0 ? (
          <p role="status" style={{ color: "#808080", margin: 0 }}>
            No videos saved yet — upload your first one above.
          </p>
        ) : (
          <ul className="vm-history-grid">
            {videos.map((video) => (
              <li key={video.id} className="card vm-history-card">
                <div className="vm-history-media">
                  {video.url ? (
                    <video
                      src={video.url}
                      preload="metadata"
                      controls
                      playsInline
                      aria-label={`Preview of ${video.title || video.file_name || "video"}`}
                    />
                  ) : (
                    <p className="vm-history-placeholder" role="status">
                      No preview available.
                    </p>
                  )}
                </div>
                <h3 className="vm-history-title">
                  {video.title || video.file_name || "(untitled)"}
                </h3>
                {video.description ? (
                  <p style={{ color: "#9E9E9E", fontSize: 14, margin: 0, lineHeight: 1.5 }}>
                    {video.description}
                  </p>
                ) : null}
                <p className="vm-history-meta">
                  <span>{formatDate(video.created_at)}</span>
                </p>
                {itemErrors[video.id] ? (
                  <ErrorAlert message={itemErrors[video.id]} />
                ) : null}
                <div className="vm-history-actions">
                  {video.url ? (
                    <a
                      className="button vm-btn-primary"
                      href={video.url}
                      download={video.file_name || true}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`Download ${video.title || "video"}`}
                    >
                      Download
                    </a>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => void handleDelete(video)}
                    disabled={deletingId === video.id}
                    aria-label={`Delete ${video.title || "video"}`}
                    style={{ minHeight: 44 }}
                  >
                    {deletingId === video.id ? "Deleting…" : "Delete"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
