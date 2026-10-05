# Vidiomaker — AI Video Studio

100% frontend on Vercel + Supabase + Canvas/MediaRecorder rendering.
No Laravel, no VPS, no native encoder binary, no wasm download — rendering runs in
the browser via Canvas 2D + MediaRecorder (MP4, no COOP/COEP headers required).

Black background `#000000` + grey text `#B8B8B8` / `#9E9E9E`.
Type words (or upload pictures) → OpenRouter generates script/scenes (via
Next.js Route Handlers) → Cloudflare Workers AI generates images (4 selectable
FLUX models) → Canvas + MediaRecorder
Ken Burns animation + text overlays → vertical videos for Reels / TikTok /
Shorts, several per day.

Full builder instructions: see `AI_EXECUTION_PLAN.md` (6-stage plan + file structure map).

![Demo](docs/demo.gif)
<!-- Demo GIF placeholder: replace `docs/demo.gif` with a screen recording of
     Create → Generate script → Generate images → Render → Download. -->

## Requirements

| Requirement | Version | Check |
|-------------|---------|-------|
| Node.js | 20+ | `node --version` |
| Supabase project | cloud (free tier OK) | dashboard URL + anon key |
| OpenRouter API key | per user, via Settings UI | `https://openrouter.ai/keys` |
| Cloudflare Account ID + API token | server-only, via `frontend/.env.local` | `dash.cloudflare.com` → Workers AI → Use REST API |
| Modern browser | Chrome/Edge/Firefox/Safari (recent) | records Canvas + MediaRecorder MP4 |

## Quick start (fresh clone — no backend steps)

```bash
# 1. clone
git clone <repo-url> vidiomaker && cd vidiomaker

# 2. frontend (Next.js + Route Handlers + Canvas/MediaRecorder) — http://localhost:3000 (black/grey UI)
cd frontend
npm install
cp .env.example .env.local   # set NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY + CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN
npm run dev

# 3. supabase — paste supabase/schema.sql into Supabase Dashboard → SQL editor → Run
#    then create buckets uploads/ and renders/ (see supabase/storage.md)
```

## Install detail

### Frontend

```bash
cd frontend
npm install
cp .env.example .env.local
npm run dev     # dev on :3000
npm run build   # must pass (Stage 6.4)
npm run lint    # eslint via next lint
```

No backend install — API logic lives in Next.js Route Handlers
(`frontend/src/app/api/*`), rendering in `frontend/src/lib/render.ts`
(Canvas 2D + MediaRecorder MP4).

### Supabase SQL import

1. Open Supabase Dashboard → your project → SQL editor.
2. Paste the full contents of `supabase/schema.sql` → Run.
   Idempotent (`create table if not exists`, `drop policy if exists` before create).
   Creates `public.videos`, `public.scenes`, trigram indexes, and RLS:
   `anon` = `select` only, `authenticated` = full access, backend service-role bypasses RLS.
3. Storage → create **private** buckets `uploads/` and `renders/` (see `supabase/storage.md`).
   `anon` gets no storage policies; `authenticated` may insert `jpg/png` into `uploads/`;
   final MP4s in `renders/` are written by the backend service-role key and read via signed URLs.

### Video engine (Canvas 2D + MediaRecorder)

No native encoder binary, no VPS, no wasm download, no COOP/COEP headers. The browser
paints every frame on a Canvas 2D (Ken Burns + captions) and records it with
MediaRecorder to MP4. Lighter/faster than the old wasm path — no ~30 MB core
download. If render fails to start, see Troubleshooting → "Video engine failed to start".

## Environment variables

Copy from the committed example (safe — it contains no secrets):

```bash
cp frontend/.env.example frontend/.env.local
```

Real `.env.local` is never committed (see root `.gitignore` + `frontend/.gitignore`).

| File | Variable | Purpose / default |
|------|----------|-------------------|
| `frontend/.env.local` | `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `frontend/.env.local` | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase publishable key (safe for browser) |
| `frontend/.env.local` | `OPENROUTER_API_KEY` (server-only, optional) | Fallback server key for Route Handlers (per-user key from Settings UI takes precedence; never `NEXT_PUBLIC_`) |
| `frontend/.env.local` | `SUPABASE_SERVICE_ROLE_KEY` (server-only, optional) | Route Handler key only, never expose to browser |
| `frontend/.env.local` | `CLOUDFLARE_ACCOUNT_ID` (server-only, required for images) | Cloudflare Account ID (dash → Workers AI → Use REST API). Never `NEXT_PUBLIC_` |
| `frontend/.env.local` | `CLOUDFLARE_API_TOKEN` (server-only, required for images) | Workers AI token (Read + Edit). Never expose to browser |

> No `NEXT_PUBLIC_API_URL` — API calls go to same-origin Next.js Route
> Handlers (`/api/*`), not a Laravel backend.

## Usage guide

1. **Enter key** — open `/settings`, paste your OpenRouter key (`sk-or-v1-...`),
   press **Test** (tiny `openai/gpt-4o-mini` "hi" completion), then **Save**.
   Header shows `● Key set` / `○ No key`. Keys travel in POST body /
   `Authorization` header only — never in URLs, never in logs (server stores a
   `****last4` hint only).
2. **Pick model** — on Create → OpenRouter tab: live list from
   same-origin `GET /api/models` (Route Handler proxies
   `https://openrouter.ai/api/v1/models`, cached 1h, falls back to last cached
   list). Search, vendor group (`id.split('/')[0]`), pricing + `context_length`
   shown. Selection persists to `localStorage: vidiomaker.model`. Direct
   fallback to OpenRouter if the handler is unreachable.
3. **Type words** — Topic/words field (e.g. "lonely robot finds garden"),
   optional negative prompt, scene count 3–8, duration 3–6s per scene,
   aspect `1080x1920` vertical (default) or `1920x1080`. Optionally upload
   JPG/PNG pictures (≤10MB each, `uploads/` bucket) as story source.
4. **Generate** — Generate script → edit scenes inline (per-scene Regenerate
   touches only that `idx`, others preserved; prompts/seeds/durations logged in
   Debug panel) → pick an image model on the Images step (FLUX.1 Schnell,
   FLUX.2 Klein 4B / 9B, FLUX.2 Dev via Cloudflare Workers AI;
   60s timeout, retries 2s→4s→8s, per-scene Retry/Regen with new seed;
   needs `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` server-side) →
   CSS Ken Burns instant preview → **Render** (Canvas + MediaRecorder
   Ken Burns + captions, progress in
   the Render panel).
5. **Download** — History page lists videos with `<video>` preview (black/grey,
   `preload="metadata"`), **Download** MP4, Delete, Regenerate single bad scene
   without full rebuild (logged `model_id`, `prompts`, `seeds`, `image_urls`, `durations`).

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `Model list failed (...)` | Route Handler unreachable? Frontend falls back to `https://openrouter.ai/api/v1/models` directly. Check network, click Retry. |
| `Invalid API key (401)` / OpenRouter 401 | Settings → re-paste key → Test → Save. Generation uses the new key immediately via `Authorization: Bearer`. Server never logs full keys. |
| `Cloudflare timed out` / `Cloudflare busy, retrying scene 2/5...` | Service busy. Auto-retries (2s→4s→8s), then per-scene **Retry** resumes missing scenes only (downloaded stills are kept; `uploads/` custom pictures are never overwritten). Same seed+prompt+model reproduces the image; Regen-image assigns a new seed. If you see "Cloudflare is not configured", add `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` to `frontend/.env.local` and restart (Settings → Cloudflare shows status). |
| `Video engine failed to start` | Recording could not start (unsupported browser, backgrounded tab, or low memory). Use a recent Chrome/Edge/Safari, keep the tab open and visible, reload, tap Retry. No COOP/COEP headers — do not add them. |
| `Please describe your video idea first.` (422) | Empty topic — fill the words field. Validation errors highlight the field, never a bare 500. |
| `npm run lint` → `'next' is not recognized` | `node_modules/` missing. Run `cd frontend && npm install`. Note: repo has no eslint config yet — `next lint` will prompt to set one up on first run. |
| Supabase advisors | Dashboard → Database → Advisors → run **Security** + **Performance**; expect: RLS enabled on `videos`/`scenes`, no `anon` storage insert, indexes on `(video_id, idx)` present. |

## Security notes

- Secrets only in `frontend/.env.local` (never committed; `.gitignore` covers
  `.env`, `.env.local`, `frontend/.env.local`). Verified: no real keys in repo
  (`sk-or-` hit is a UI placeholder only); no `service_role` key in client code.
- RLS **on** for `public.videos` + `public.scenes` (`supabase/schema.sql`):
  `alter table ... enable row level security`, anon-select / authenticated-all policies.
- Rate-limit: Route Handlers (`/api/*`) carry a lightweight in-memory
  throttle (≈30 req/min per IP); Vercel edge + Supabase RLS provide the rest.
- Validation: all mutating Route Handlers validate inputs (topic/model/scene
  shapes, narration sanitized — no raw HTML) + parameterized Supabase queries
  (no string-interpolated SQL). API keys are masked `****last4` in logs;
  full keys never logged/stored server-side.
- React: user text renders as plain text (default escaping); no
  `dangerouslySetInnerHTML` for user text anywhere in `frontend/src`
  (comment-only mentions excepted).

## Deploy (Vercel + Supabase, no backend server)

| Part | Target | Steps |
|------|--------|-------|
| Frontend | Vercel | Import `frontend/` → Framework Next.js → env `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (plus server-only `OPENROUTER_API_KEY` / `SUPABASE_SERVICE_ROLE_KEY` if used) → Deploy. `public/robots.txt` + `public/sitemap.xml` ship automatically; update `sitemap.xml` host to production domain. No COOP/COEP headers needed (Canvas + MediaRecorder, no wasm). |
| Database/Storage | Supabase cloud | Create project → run `supabase/schema.sql` in SQL editor → create private buckets `uploads/`, `renders/` → copy URL + anon key to frontend env (service-role key stays server-only in Route Handler env) → re-run Database Advisors after import. |

Post-deploy smoke: `GET https://<domain>/api/health` → ok;
frontend Create flow 1–5 above works; History shows the rendered MP4;
all pages black (`#000`) / grey (`#B8B8B8`), no console errors, mobile 360px usable.

## Stage 6.1 + 6.3 + 6.4 delta (Agent 5 — QA fixes, for Agent 6 to fold in)

- New shared error surface: `frontend/src/lib/errors.ts` (network → retry hint,
  401 → Settings hint, 429 → countdown hint, 422 → field hint,
  `Pollinations timed out, retrying scene 2/5...`) + `ErrorAlert.tsx`
  (renders the Settings link, 30s auto-retry countdown, Retry). Wired into the
  wizard (`page.tsx`), `ModelPicker`, `VideoPreview`, History, and `SettingsApiKey`
  (422 highlights the key box; fixed the 401 hint that linked Settings to itself).
- New routes: `/history` was missing (empty dir → 404); created
  `app/history/page.tsx` + `HistoryList` island (Supabase videos + scene count,
  lazy stills, `<video preload="metadata">`, Download/Delete/Regenerate,
  Supabase-unconfigured guard). Added `/create` alias of the wizard with
  canonical SEO tag; header nav Create → `/create` (`/` still works, no redirect).
- SEO/perf: `layout.tsx` metadataBase + title template + keywords + robots +
  canonical + full OG/Twitter + `theme-color #000` + dark `colorScheme` + favicon +
  skip-link + footer. `sitemap.xml` now lists `/`, `/create`, `/history`, `/settings`.
  `globals.css`: `color-scheme: dark`, focus-visible rings, `img/video{max-width:100%}`,
  dark `select option`, 360px breakpoint, `prefers-reduced-motion` freeze.
- Backend (messages only, no logic): OpenRouter 401 → points to Settings (`/settings`),
  429 → notes the 30s auto-retry. Fixed a doubled `}` in `page.tsx` left by a
  concurrent edit + added the missing `VideoPreview` import.
- Verified 2026-09-29: `npx tsc --noEmit` clean; `next build` passes
  (`/`, `/create`, `/history`, `/settings`, 404, all static); prod server smoke
  `200` on `/`, `/create`, `/history`, `/settings`, `/robots.txt`, `/sitemap.xml`
  with theme-color/OG/skip-link/canonical present. `npm run lint` still has no
  ESLint config (pre-existing). Lighthouse mobile ≥85 not runnable in this sandbox
  (no browser); first-load JS ≈ 88–108 kB shared, 165 kB on `/history`.
  Remaining: real-device 360px pass, Lighthouse run with network, `php artisan test`
  (backend env), Supabase advisors re-run after import.
