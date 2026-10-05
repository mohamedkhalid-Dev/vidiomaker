# Vidiomaker — Supabase Storage buckets (Stage 1)

Create these two **private** buckets in Supabase Dashboard → Storage
(or via `supabase` CLI). Do NOT make them public — the app serves files
through signed URLs / the Laravel backend.

| Bucket    | Purpose                                   | Limits / notes                                              |
|-----------|-------------------------------------------|-------------------------------------------------------------|
| `uploads/` | User-uploaded source pictures per scene  | 10 MB max per file, `jpg/jpeg/png` only. Frontend validates size + mime before upload. Path: `uploads/{video_id}/scene-{idx}.jpg`. Skipped by Pollinations for that scene idx (Stage 4). |
| `renders/` | Final rendered MP4s (Canvas + MediaRecorder output) | `video/mp4` only. Browser renders via Canvas 2D + MediaRecorder, then uploads to `renders/` (Stage 5). Path: `renders/{video_id}.mp4`. Frontend History page streams via signed URL with `preload="metadata"`. |

## RLS notes (storage.objects)

Buckets are private, so no public `select` policy. Minimal policy set:

- `authenticated` may `insert` into `uploads/` (own video pictures) with
  `bucket_id = 'uploads'` and `content-type` in
  `image/jpeg, image/png` — enforce the 10 MB limit client-side AND with a
  storage insert size check where available.
- `authenticated` may `select` (download) objects it needs for preview;
  final MP4s in `renders/` are written by the backend service-role key
  (bypasses RLS) and read back via short-lived signed URLs.
- `anon` gets **no** storage policies (unlike the `videos`/`scenes` tables,
  which allow anon `select`). Never add an `anon insert/update/delete`
  policy on storage.

Key rotation: publishable (anon) key is safe to embed in
`frontend/.env.example` as `NEXT_PUBLIC_SUPABASE_ANON_KEY`. The
service-role key lives ONLY in `backend/.env` (never committed, never
sent to the browser).
