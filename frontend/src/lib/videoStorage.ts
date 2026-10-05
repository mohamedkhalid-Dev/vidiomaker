import { isSupabaseConfigured, supabase } from "./supabase";

/**
 * Browser-only video library (no backend).
 * Files go straight to the public Supabase Storage bucket `videos`,
 * metadata (title, URL, description) lives in `public.videos`.
 * Works with the anon (publishable) key — see Supabase RLS policies.
 */

export const VIDEOS_BUCKET = "videos";

/** 200 MB per video — keeps uploads reliable on slow connections. */
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

export interface BrowserVideo {
  id: string;
  title: string | null;
  description: string | null;
  url: string | null;
  storage_path: string | null;
  file_name: string | null;
  created_at: string | null;
}

export interface UploadBrowserVideoOptions {
  title?: string;
  description?: string;
}

function requireSupabase(): void {
  if (!isSupabaseConfigured()) {
    throw new Error(
      "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY in frontend/.env.local, then retry."
    );
  }
}

function sanitizeFileName(name: string): string {
  return (
    name
      .trim()
      .replace(/\s+/g, "_")
      .replace(/[^a-zA-Z0-9._-]/g, "")
      .slice(-120) || "video.mp4"
  );
}

function validationError(file: File): string | null {
  if (!file.type.startsWith("video/")) {
    return `Only video files are allowed (you selected "${file.type || "unknown type"}").`;
  }
  if (file.size <= 0) {
    return "This file is empty. Please choose a different video.";
  }
  if (file.size > MAX_VIDEO_BYTES) {
    const mb = Math.round(file.size / (1024 * 1024));
    return `Video is ${mb} MB — the limit is ${MAX_VIDEO_BYTES / (1024 * 1024)} MB. Please compress it first.`;
  }
  return null;
}

/**
 * Upload a video straight from the browser:
 * 1. Storage `videos` bucket → 2. public URL → 3. row in `public.videos`.
 * If the DB insert fails, the uploaded object is removed again so no
 * orphan files pile up.
 */
export async function uploadBrowserVideo(
  file: File,
  options: UploadBrowserVideoOptions = {}
): Promise<BrowserVideo> {
  requireSupabase();
  const invalid = validationError(file);
  if (invalid) throw new Error(invalid);

  const path = `public/${Date.now()}_${sanitizeFileName(file.name)}`;
  const { error: uploadError } = await supabase.storage
    .from(VIDEOS_BUCKET)
    .upload(path, file, {
      contentType: file.type || "video/mp4",
      upsert: false,
    });
  if (uploadError) {
    throw new Error(
      uploadError.message.trim().length > 0
        ? `Upload failed (${uploadError.message}). Check your connection and retry.`
        : "Upload failed. Check your connection and retry."
    );
  }

  const { data: urlData } = supabase.storage
    .from(VIDEOS_BUCKET)
    .getPublicUrl(path);
  const publicUrl = urlData.publicUrl;
  const title = options.title?.trim() || file.name;
  const description = options.description?.trim() || null;

  const { data, error: insertError } = await supabase
    .from("videos")
    .insert({
      title,
      description,
      url: publicUrl,
      video_url: publicUrl,
      storage_path: path,
      file_name: file.name,
      mime_type: file.type || null,
      size_bytes: file.size,
      status: "done",
    })
    .select("id, title, description, url, storage_path, file_name, created_at")
    .maybeSingle();

  if (insertError || !data) {
    // Best-effort cleanup — the row is the source of truth for the list.
    await supabase.storage.from(VIDEOS_BUCKET).remove([path]).catch(() => {});
    throw new Error(
      insertError?.message?.trim()
        ? `Video uploaded but could not be saved (${insertError.message}). Please retry.`
        : "Video uploaded but could not be saved. Please retry."
    );
  }

  const row = data as Record<string, unknown>;
  return {
    id: String(row.id ?? ""),
    title: (row.title as string | null) ?? null,
    description: (row.description as string | null) ?? null,
    url: (row.url as string | null) ?? publicUrl,
    storage_path: (row.storage_path as string | null) ?? path,
    file_name: (row.file_name as string | null) ?? file.name,
    created_at: (row.created_at as string | null) ?? null,
  };
}

/** Newest-first list for the library UI (rows that have a playable URL). */
export async function listBrowserVideos(limit = 100): Promise<BrowserVideo[]> {
  requireSupabase();
  const { data, error } = await supabase
    .from("videos")
    .select("id, title, description, url, video_url, storage_path, file_name, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Could not load videos (${error.message}). Please retry.`);
  return ((data ?? []) as Array<Record<string, unknown>>)
    .map((row) => {
      const url =
        typeof row.url === "string" && row.url.length > 0
          ? row.url
          : typeof row.video_url === "string" && row.video_url.length > 0
            ? (row.video_url as string)
            : null;
      return {
        id: String(row.id ?? ""),
        title: (row.title as string | null) ?? null,
        description: (row.description as string | null) ?? null,
        url,
        storage_path: (row.storage_path as string | null) ?? null,
        file_name: (row.file_name as string | null) ?? null,
        created_at: (row.created_at as string | null) ?? null,
      };
    })
    .filter((video) => video.id.length > 0 && video.url !== null);
}

/**
 * Delete whenever you wish: removes the Storage object (best-effort)
 * plus the `videos` row (source of truth for the list).
 */
export async function deleteBrowserVideo(id: string, storagePath: string | null): Promise<void> {
  requireSupabase();
  if (id.trim().length === 0) throw new Error("No video selected for deletion.");
  if (storagePath && storagePath.length > 0) {
    // A missing object must never block the row delete.
    await supabase.storage.from(VIDEOS_BUCKET).remove([storagePath]).catch(() => {});
  }
  const { error } = await supabase.from("videos").delete().eq("id", id);
  if (error) throw new Error(`Could not delete this video (${error.message}). Please retry.`);
}
