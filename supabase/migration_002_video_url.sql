-- Vidiomaker — PROPOSED migration 002: videos.video_url (frontend-only deploy)
-- Status: PROPOSAL ONLY — reviewed, NOT applied to live Supabase. Agent 6 (or
-- a human) applies via Supabase Dashboard → SQL editor → Run, AFTER review.
-- Idempotent: safe to re-run (`add column if not exists`).
--
-- Gap vs deploy contract (Agent 5 audit 2026-09-30):
--   supabase/schema.sql defines videos(id,title,topic,model_id,status,
--   created_at, render_path, error_log, progress, updated_at) but NO
--   `video_url` column, while the frontend VideoRecord shape reads
--   video_url/download_url/url. render_path (e.g. renders/{id}.mp4) is the
--   storage path; video_url holds the playable URL (signed URL or public
--   gateway URL) so History <video> + Download anchors don't recompute it.
-- Everything else already matches: scenes(video_id,idx,narration,
-- image_prompt,seed,image_url,duration), RLS anon-select /
-- authenticated-write, private buckets uploads/ + renders/ (see storage.md).

alter table public.videos
  add column if not exists video_url text; -- playable URL (signed/public), nullable until first render
