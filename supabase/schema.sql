-- Vidiomaker Stage 1 — Supabase schema (videos + scenes)
-- Paste into Supabase SQL editor. Idempotent: safe to re-run.
-- Existing tables inspected first: only public.profiles exists, no videos/scenes yet.
-- This script does NOT drop anything (no destructive SQL).

-- Extensions needed:
-- pgcrypto  -> gen_random_uuid() for uuid PK defaults
-- pg_trgm   -> trigram search on title/topic/narration (history search, Stage 5/6)
-- NOTE: install in `extensions` schema (not public) to pass Supabase
-- `extension_in_public` linter. Applied via MCP 2026-09-29.
create schema if not exists extensions;
create extension if not exists "pgcrypto" with schema extensions;
create extension if not exists "pg_trgm" with schema extensions;

-- ---------------------------------------------------------------- videos ---
create table if not exists public.videos (
  id uuid primary key default gen_random_uuid(),
  title text,
  topic text,
  model_id text,
  status text not null default 'draft'
    check (status in ('draft', 'queued', 'rendering', 'done', 'failed')),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- scenes ---
create table if not exists public.scenes (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references public.videos (id) on delete cascade,
  idx int not null check (idx >= 0),
  narration text,
  image_prompt text,
  seed bigint,
  image_url text,
  duration int not null default 5 check (duration between 1 and 30)
);

-- Indexes: scene lookup per video in order (render/concat path), plus
-- trigram indexes for history search.
create index if not exists idx_scenes_video_idx
  on public.scenes (video_id, idx);
create index if not exists idx_videos_status_created
  on public.videos (status, created_at desc);
create index if not exists idx_videos_topic_trgm
  on public.videos using gin (topic gin_trgm_ops);
create index if not exists idx_scenes_narration_trgm
  on public.scenes using gin (narration gin_trgm_ops);

-- ------------------------------------------------------------- RLS ---------
alter table public.videos enable row level security;
alter table public.scenes enable row level security;

-- Anonymous (public) read-only: anyone can list/view videos + scenes.
drop policy if exists "videos_anon_select" on public.videos;
create policy "videos_anon_select"
  on public.videos for select
  to anon
  using (true);

drop policy if exists "scenes_anon_select" on public.scenes;
create policy "scenes_anon_select"
  on public.scenes for select
  to anon
  using (true);

-- Authenticated full access: insert/update/delete (+select) for app writes.
-- Frontend writes via supabase-js with the publishable key; backend writes
-- with the service-role key (bypasses RLS).
drop policy if exists "videos_auth_all" on public.videos;
create policy "videos_auth_all"
  on public.videos for all
  to authenticated
  using (true)
  with check (true);

drop policy if exists "scenes_auth_all" on public.scenes;
create policy "scenes_auth_all"
  on public.scenes for all
  to authenticated
  using (true)
  with check (true);

-- ------------------------------------------------- Stage 5: renders ------
-- Idempotent: safe to re-run. Mirrored by
-- backend/database/migrations/2026_09_29_000002_video_render_fields.php
-- (local Laravel dev/test DBs).
--
-- Status flow (unchanged CHECK): draft → queued → rendering → done | failed.
-- Buckets (see storage.md): source stills on the render server at
-- storage/app/videos/{id}/, final MP4s at renders/{video_id}.mp4
-- (Supabase Storage bucket `renders/` when uploaded via service-role key).
alter table public.videos
  add column if not exists render_path text;      -- e.g. renders/{id}.mp4
alter table public.videos
  add column if not exists error_log text;        -- friendly failure + Retry hint
alter table public.videos
  add column if not exists progress int not null default 0; -- 0–100 polling
alter table public.videos
  add column if not exists updated_at timestamptz not null default now();

-- scenes timestamps: the Laravel migration + ImageController already write
-- updated_at — these columns align Supabase with that contract.
alter table public.scenes
  add column if not exists created_at timestamptz not null default now();
alter table public.scenes
  add column if not exists updated_at timestamptz not null default now();

-- Queue view for the daily batch (06:00) + ops dashboards:
-- oldest queued/rendering videos first. polled by videos:render-queue.
-- with (security_invoker=true): respects querying user's RLS (fixes
-- `security_definer_view` linter ERROR, applied via MCP 2026-09-29).
create or replace view public.render_queue
with (security_invoker = true) as
  select id, title, topic, model_id, status, created_at, updated_at
  from public.videos
  where status in ('queued', 'rendering')
  order by created_at asc;
