-- Vidiomaker migration 003 — saved image library (`public.images`).
-- Idempotent: safe to re-run. Additive only (no changes to videos/scenes).
-- Paste into Supabase SQL editor OR apply via CLI.
--
-- Purpose: backs the "Choose library" picker (ImageLibraryPicker.tsx +
-- lib/selectLibraryImage.ts). Rows are written whenever a still is
-- generated/uploaded (description = scene imagePrompt); the picker reads
-- newest-first with ilike pre-filter + client keyword re-rank.
-- Requires pg_trgm (created in schema.sql) for the similarity index.

create extension if not exists "pg_trgm" with schema extensions;

create table if not exists public.images (
  id uuid primary key default gen_random_uuid(),
  description text not null default '',
  image_url text not null,
  prompt text,
  created_at timestamptz not null default now()
);

create index if not exists idx_images_created
  on public.images (created_at desc);
create index if not exists idx_images_description_trgm
  on public.images using gin (description gin_trgm_ops);

alter table public.images enable row level security;

drop policy if exists "images_anon_select" on public.images;
create policy "images_anon_select"
  on public.images for select
  to anon
  using (true);

drop policy if exists "images_auth_all" on public.images;
create policy "images_auth_all"
  on public.images for all
  to authenticated
  using (true)
  with check (true);
