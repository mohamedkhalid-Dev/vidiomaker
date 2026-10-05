"use client";

import { useCallback, useEffect, useState } from "react";
import {
  deleteVideo,
  fetchVideoHistory,
  getVideoDownloadUrl,
  regenerateVideo,
  type VideoRecord,
} from "../lib/api";
import { isSupabaseConfigured, supabase } from "../lib/supabase";
import { toUserMessage } from "../lib/errors";
import ErrorAlert from "./ErrorAlert";

/**
 * Stage 5.4 — History list (Supabase videos via lib/api.ts, Supabase
 * thumbnails for still preview).
 *
 * - Black/grey theme, responsive grid (1 col @360px → 3 col desktop).
 * - Final MP4 preview via `<video preload="metadata">` (metadata only —
 *   no full download until the user presses play) + Download anchor via
 *   getVideoDownloadUrl() (Supabase `renders/` public URL).
 * - Delete via deleteVideo() (removes Storage MP4 + DB rows);
 *   Regenerate via regenerateVideo() (fresh Canvas + MediaRecorder pass with
 *   logged prompts/seeds, scenes kept).
 * - Stills via `loading="lazy"` images; all failures surface as an
 *   ErrorAlert with Retry (never a blank error).
 */

interface HistoryVideo {
  id: string;
  title: string | null;
  topic: string | null;
  model_id: string | null;
  status: string;
  created_at: string;
  previewUrl: string | null;
  sceneCount: number;
}

function LoadingSkeleton(): React.ReactElement {
  return (
    <div aria-busy="true" aria-label="Loading history" style={{ display: "grid", gap: 12 }}>
      {[0, 1, 2].map((index) => (
        <div
          key={index}
          className="vm-history-shimmer"
          style={{ minHeight: 120, borderRadius: 12 }}
        />
      ))}
    </div>
  );
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/** First http(s) still for a video (Supabase scenes) — lazy preview only. */
async function fetchStillPreview(videoId: string): Promise<{ url: string | null; count: number }> {
  if (!isSupabaseConfigured()) return { url: null, count: 0 };
  try {
    const { data: scenes } = await supabase
      .from("scenes")
      .select("image_url")
      .eq("video_id", videoId)
      .order("idx", { ascending: true })
      .limit(8);
    const list = (scenes ?? []) as { image_url: string | null }[];
    const firstHttp = list.find(
      (scene) => typeof scene.image_url === "string" && /^https?:\/\//.test(scene.image_url)
    );
    return { url: firstHttp?.image_url ?? null, count: list.length };
  } catch {
    return { url: null, count: 0 };
  }
}

export default function HistoryList(): React.ReactElement {
  const [videos, setVideos] = useState<HistoryVideo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [regenId, setRegenId] = useState<string | null>(null);
  const [videoErrors, setVideoErrors] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Primary: Supabase history (lib/api.ts) — returns download-ready
      // public `renders/` URLs. Fallback: Supabase direct query.
      let records: VideoRecord[] = [];
      try {
        records = await fetchVideoHistory();
      } catch (apiErr) {
        if (!isSupabaseConfigured()) throw apiErr;
        const { data, error: queryError } = await supabase
          .from("videos")
          .select("id, title, topic, model_id, status, created_at")
          .order("created_at", { ascending: false })
          .limit(50);
        if (queryError) throw new Error(queryError.message);
        records = ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
          id: String(row.id ?? ""),
          title: (row.title as string | null) ?? null,
          topic: (row.topic as string | null) ?? null,
          model_id: (row.model_id as string | null) ?? null,
          status: typeof row.status === "string" ? row.status : "draft",
          created_at: typeof row.created_at === "string" ? row.created_at : "",
        }));
      }

      const withPreviews: HistoryVideo[] = await Promise.all(
        records.map(async (row) => {
          const still = await fetchStillPreview(row.id);
          const count =
            typeof row.scenes_count === "number" ? row.scenes_count : still.count;
          return {
            id: row.id,
            title: row.title,
            topic: row.topic,
            model_id: row.model_id,
            status: row.status,
            created_at: row.created_at ?? "",
            previewUrl: still.url,
            sceneCount: count,
          };
        })
      );
      setVideos(withPreviews);
    } catch (err) {
      setError(toUserMessage(err, "Could not load history. Please retry."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleDelete = useCallback(async (id: string, label: string) => {
    // Confirm before delete — destructive, no undo.
    if (
      typeof window !== "undefined" &&
      !window.confirm(`Delete "${label}"? This removes the video and its files.`)
    ) {
      return;
    }
    setDeletingId(id);
    try {
      // Delete removes the Storage MP4 + DB rows (scenes + video).
      await deleteVideo(id);
      setVideos((prev) => prev.filter((video) => video.id !== id));
    } catch (err) {
      setVideoErrors((prev) => ({
        ...prev,
        [id]: toUserMessage(err, "Could not delete this video. Please retry."),
      }));
    } finally {
      setDeletingId(null);
    }
  }, []);

  const handleRegenerate = useCallback(async (id: string) => {
    setRegenId(id);
    setVideoErrors((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    try {
      // Fresh Canvas + MediaRecorder pass with logged prompts/seeds (scenes kept).
      await regenerateVideo(id);
      setVideos((prev) =>
        prev.map((video) => (video.id === id ? { ...video, status: "queued" } : video))
      );
    } catch (err) {
      setVideoErrors((prev) => ({
        ...prev,
        [id]: toUserMessage(err, "Could not re-queue this video. Please retry."),
      }));
    } finally {
      setRegenId(null);
    }
  }, []);

  if (loading) return <LoadingSkeleton />;

  if (error) {
    return <ErrorAlert message={error} onRetry={() => void load()} retryLabel="Reload history" />;
  }

  if (videos.length === 0) {
    return (
      <div className="card" role="status" aria-live="polite" style={{ textAlign: "center", padding: 24 }}>
        <p style={{ margin: "0 0 12px", lineHeight: 1.6 }}>
          No videos yet. Create your first vertical video in under a minute.
        </p>
        <a className="button" href="/create" style={{ display: "inline-flex" }}>
          Create a video
        </a>
      </div>
    );
  }

  return (
    <ul className="vm-history-grid">
      {videos.map((video) => {
        const downloadUrl = getVideoDownloadUrl(video.id);
        return (
          <li key={video.id} className="card vm-history-card">
            <div className="vm-history-media">
              {video.status === "done" ? (
                <video
                  src={downloadUrl}
                  preload="metadata"
                  controls
                  playsInline
                  aria-label={`Preview of ${video.title || video.topic || "video"}`}
                  onError={() =>
                    setVideoErrors((prev) => ({
                      ...prev,
                      [video.id]:
                        "Preview is not ready yet. Tap Download below, or re-render from Create.",
                    }))
                  }
                />
              ) : video.previewUrl ? (
                <img
                  src={video.previewUrl}
                  alt={`First scene still for ${video.title || video.topic || "video"}`}
                  loading="lazy"
                  decoding="async"
                />
              ) : (
                <p className="vm-history-placeholder" role="status">
                  {video.status === "failed"
                    ? "Render failed — tap Retry below to try again."
                    : "No preview yet — generate images, then render."}
                </p>
              )}
            </div>

            <h2 className="vm-history-title">{video.title || video.topic || "(untitled)"}</h2>
            <p className="vm-history-meta">
              <span className="vm-status-badge" role="status">{video.status}</span>
              <span>
                {video.sceneCount} scene{video.sceneCount === 1 ? "" : "s"}
              </span>
              <span>{formatDate(video.created_at)}</span>
            </p>
            {video.model_id ? (
              <p className="vm-history-model">{video.model_id}</p>
            ) : null}

            {videoErrors[video.id] ? (
              <div aria-live="polite">
                <ErrorAlert message={videoErrors[video.id]} />
              </div>
            ) : null}

            {/* One primary action (Download); the rest stay secondary. */}
            <div className="vm-history-actions">
              <a
                className="button vm-btn-primary"
                href={downloadUrl}
                download
                aria-label={`Download ${video.title || video.topic || "video"} (MP4)`}
              >
                Download
              </a>
              <details className="vm-more">
                <summary>More</summary>
                <div className="vm-more-actions">
                  <button
                    type="button"
                    onClick={() => void handleRegenerate(video.id)}
                    disabled={regenId === video.id}
                    aria-label={`Regenerate ${video.title || "video"}`}
                    title="Fresh render pass with logged prompts and seeds"
                  >
                    {regenId === video.id ? "Queued…" : "Regenerate"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDelete(video.id, video.title || video.topic || "video")}
                    disabled={deletingId === video.id}
                    aria-label={`Delete ${video.title || "video"}`}
                  >
                    {deletingId === video.id ? "Deleting…" : "Delete"}
                  </button>
                </div>
              </details>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
