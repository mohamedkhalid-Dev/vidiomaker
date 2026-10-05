# Vidiomaker — Site File Structure Map

> Generated 2026-10-01. Excludes `node_modules/`, `.next/`, `.git/`.
> Stack: Next.js 14 frontend + Supabase (Postgres + Storage) + Canvas/MediaRecorder rendering. No Laravel backend — API lives in Next.js Route Handlers.

## Root `vidiomaker/`

```
vidiomaker/
├── SITE_MAP.md              # this file
├── README.md                # overview, install, env, usage, deploy, troubleshooting
├── package.json             # root wrapper (private, start -> frontend dev)
├── .gitignore               # node, .next, .env.local, Laravel/vendor, *.mp4, OS/editor
├── supabase/
│   ├── schema.sql                 # videos + scenes tables, trigram indexes, RLS
│   ├── migration_002_video_url.sql
│   └── storage.md                 # uploads/ + renders/ private buckets guide
└── frontend/                # deploy this folder to Vercel (Next.js)
    ├── package.json         # next 14.2.5, react 18, @supabase/supabase-js
    ├── package-lock.json
    ├── next.config.mjs
    ├── tsconfig.json
    ├── next-env.d.ts
    ├── vercel.json
    ├── .env.example         # safe template (no secrets)
    ├── .env.local           # real secrets, never committed
    ├── public/
    │   ├── favicon.ico
    │   ├── robots.txt
    │   └── sitemap.xml      # /, /create, /history, /settings
    └── src/
        ├── app/             # routes (App Router)
        │   ├── layout.tsx           # SEO metadata, header nav, KeyIndicator, footer
        │   ├── page.tsx             # / — 4-step wizard: Input → Script → Images → Video
        │   ├── globals.css          # dark theme, focus rings, responsive, reduced-motion
        │   ├── create/page.tsx      # /create — alias of wizard + canonical SEO
        │   ├── history/page.tsx     # /history — server shell + HistoryList island
        │   ├── settings/page.tsx    # /settings — ApiKey + Cloudflare + Prefs + Instructions
        │   └── api/                 # same-origin Route Handlers (no NEXT_PUBLIC_API_URL)
        │       ├── generate-script/route.ts   # OpenRouter script/scenes gen
        │       ├── regenerate-scene/route.ts  # single-scene regen by idx
        │       ├── generate-image/route.ts    # Cloudflare Workers AI FLUX
        │       └── models/
        │           ├── route.ts       # GET /api/models proxy, 1h cache + fallback
        │           └── test/route.ts  # key test via openai/gpt-4o-mini "hi"
        ├── components/      # client islands (15)
        │   ├── TopicInput.tsx                 # words + sceneCount/duration/aspect + negativePrompt
        │   ├── ImageInput.tsx                 # drag-drop JPG/PNG ≤10MB → Supabase uploads/
        │   ├── ModelPicker.tsx                # OpenRouter live list, persists vidiomaker.model
        │   ├── ImageModelPicker.tsx           # FLUX.1 Schnell / FLUX.2 Klein 4B/9B / FLUX.2 Dev
        │   ├── CustomInstructions.tsx         # stylePreset, tone, language, audience
        │   ├── ScriptEditor.tsx               # inline scene edit, per-scene regen
        │   ├── ImageGrid.tsx                  # stills grid, per-card Retry/Regen
        │   ├── VideoPreview.tsx               # CSS Ken Burns preview → Canvas + MediaRecorder MP4 + download
        │   ├── HistoryList.tsx                # Supabase videos + scene count, video/download/delete
        │   ├── AuthButton.tsx
        │   ├── KeyIndicator.tsx               # header ● Key set / ○ No key
        │   ├── ErrorAlert.tsx                 # 401→Settings link, 429→30s countdown, retry hint
        │   ├── SettingsApiKey.tsx             # key paste/test/save + default model/aspect prefs
        │   ├── SettingsCloudflare.tsx         # Cloudflare status display
        │   ├── SettingsCustomInstructions.tsx # persisted defaults, same keys as wizard
        │   └── KeyIndicator.tsx
        └── lib/             # helpers (10)
            ├── api.ts                 # generateScriptWithOptions, regenerateScriptScene
            ├── openrouter.ts          # MODEL_STORAGE_KEY, model list/fetch
            ├── cloudflare.ts          # IMAGE_MODEL_STORAGE_KEY, normalizeImageModel
            ├── images.ts              # generateAllSceneImages, regenerateSceneImage, persistSceneImage
            ├── render.ts              # render orchestration
            ├── render.ts              # Canvas 2D + MediaRecorder MP4 (no wasm, no COOP/COEP)
            ├── supabase.ts            # browser client (URL + anon key only)
            ├── types.ts               # VideoOptions, VideoAspect, limits, presets
            ├── customInstructions.ts  # load/save/sanitize localStorage defaults
            └── errors.ts              # toUserMessage, isRateLimitedMessage
```

## Routes (URLs)

| URL | File | Purpose |
|-----|------|---------|
| `/` | `src/app/page.tsx` | Main 4-step wizard |
| `/create` | `src/app/create/page.tsx` | Same wizard, clean URL + canonical |
| `/history` | `src/app/history/page.tsx` | Video history, preview, download |
| `/settings` | `src/app/settings/page.tsx` | Keys + defaults |
| `/api/generate-script` | `src/app/api/generate-script/route.ts` | Script generation |
| `/api/regenerate-scene` | `src/app/api/regenerate-scene/route.ts` | One scene regen |
| `/api/generate-image` | `src/app/api/generate-image/route.ts` | Image generation |
| `/api/models` | `src/app/api/models/route.ts` | Model list proxy |
| `/api/models/test` | `src/app/api/models/test/route.ts` | Key validation |

## Data flow

`TopicInput/ImageInput` → `POST /api/generate-script` (OpenRouter) → `ScriptEditor` → `POST /api/generate-image` (Cloudflare FLUX) → `VideoPreview` (Canvas Ken Burns + captions + MediaRecorder MP4) → Supabase `videos/scenes` + Storage `uploads/` (inputs) / `renders/` (MP4s).

## Supabase

- `supabase/schema.sql`: `public.videos`, `public.scenes`, RLS (anon=select, authenticated=full, service-role bypass).
- `supabase/storage.md`: private buckets `uploads/`, `renders/`.
