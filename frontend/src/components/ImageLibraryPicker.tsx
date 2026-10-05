"use client";

/**
 * Vidiomaker — ImageLibraryPicker (additive; generation flow untouched).
 *
 * Mount INSIDE the wizard Images step next to the existing generate button,
 * behind a parent-owned `Generate new ✨ | Choose library 🖼️` toggle:
 *
 * ```tsx
 * const [mode, setMode] = useState<"generate" | "library">("generate");
 * {mode === "generate" ? <ExistingGenerateUI/> : (
 *   <ImageLibraryPicker
 *     sceneText={scenes[activeIdx]?.imagePrompt ?? topic}
 *     onSelect={(item) => applyLibraryImageToScene(activeIdx, item)}
 *     selectedId={libraryChoiceByScene[activeIdx]?.id}
 *   />
 * )}
 * ```
 *
 * - Data: `supabase.from("images")` (see lib/selectLibraryImage.ts +
 *   migration_003_images_library.sql). Missing table → friendly empty state.
 * - AI-assist: keyword rank is instant + free; "✨ AI pick" uses OpenRouter
 *   with the user's own key/model (Settings key, never hardcoded).
 * - Theme: black/grey (#000/#111/#1A1A1A, text #B8B8B8, heading #D4D4D4),
 *   responsive auto-fill grid, 44px+ touch targets, loading skeletons.
 */

import { useEffect, useMemo, useState } from "react";
import { isSupabaseConfigured } from "../lib/supabase";
import {
  aiPickLibraryImageId,
  fetchLibraryImages,
  scoreLibraryImages,
  type LibraryImage,
} from "../lib/selectLibraryImage";

export interface ImageLibraryPickerProps {
  /** Topic / narration / imagePrompt text the AI should match against. */
  sceneText?: string;
  /** Called when the user taps a thumbnail (parent writes imageUrls[idx]). */
  onSelect: (item: LibraryImage) => void;
  /** Currently chosen library id (highlight ring), if any. */
  selectedId?: string | null;
  /** User's OpenRouter key for the optional AI-pick (Settings key). */
  openRouterKey?: string;
  /** Chat model id for the AI-pick (defaults to openai/gpt-4o-mini). */
  openRouterModel?: string;
}

const THEME = {
  text: "#B8B8B8",
  muted: "#808080",
  card: "#111",
  border: "#2A2A2A",
  button: "#1A1A1A",
  heading: "#D4D4D4",
} as const;

function SkeletonGrid({ count = 6 }: { count?: number }): React.ReactElement {
  return (
    <div
      aria-busy="true"
      aria-label="Loading saved images"
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
        gap: 12,
      }}
    >
      {Array.from({ length: count }).map((_, i) => (
        <div
          // eslint-disable-next-line react/no-array-index-key
          key={i}
          style={{
            aspectRatio: "9 / 16",
            borderRadius: 8,
            border: `1px solid ${THEME.border}`,
            background:
              "linear-gradient(100deg, #111 30%, #1C1C1C 50%, #111 70%)",
            backgroundSize: "200% 100%",
            animation: "vm-lib-pulse 1.4s ease-in-out infinite",
          }}
        />
      ))}
      <style>{`@keyframes vm-lib-pulse { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }`}</style>
    </div>
  );
}

export default function ImageLibraryPicker({
  sceneText = "",
  onSelect,
  selectedId = null,
  openRouterKey = "",
  openRouterModel = "",
}: ImageLibraryPickerProps): React.ReactElement {
  const [items, setItems] = useState<LibraryImage[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiPickId, setAiPickId] = useState<string | null>(null);
  const [aiNote, setAiNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void fetchLibraryImages()
      .then((rows) => {
        if (!cancelled) setItems(rows);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const ranked = useMemo(
    () => scoreLibraryImages(search || sceneText, items, 60),
    [search, sceneText, items],
  );

  async function handleAiPick(): Promise<void> {
    const query = (search || sceneText).trim();
    if (query.length === 0 || items.length === 0) {
      setAiNote("Type a scene description first, then tap AI pick.");
      return;
    }
    if (!openRouterKey.trim()) {
      // Free fallback: top keyword match becomes the "AI" suggestion.
      const top = ranked[0] ?? null;
      setAiPickId(top ? top.id : null);
      setAiNote(
        top
          ? `Top keyword match (no API key — add one in Settings for LLM ranking).`
          : "No keyword match — try a shorter search.",
      );
      return;
    }
    setAiLoading(true);
    setAiNote(null);
    try {
      const bestId = await aiPickLibraryImageId(query, items.slice(0, 30), {
        apiKey: openRouterKey,
        model: openRouterModel,
      });
      setAiPickId(bestId);
      setAiNote(
        bestId
          ? "AI suggestion ready — highlighted below. Tap it to use."
          : "AI found no close match — browse or refine the search.",
      );
    } finally {
      setAiLoading(false);
    }
  }

  return (
    <section
      aria-label="Choose a saved image"
      style={{
        background: "#000",
        color: THEME.text,
        border: `1px solid ${THEME.border}`,
        borderRadius: 12,
        padding: 16,
        display: "grid",
        gap: 12,
      }}
    >
      <div
        style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}
      >
        <label htmlFor="vm-lib-search" style={{ flex: "1 1 200px" }}>
          <span className="sr-only">Search saved images</span>
          <input
            id="vm-lib-search"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search library… e.g. glowing cave"
            aria-label="Search saved images by description"
            style={{
              width: "100%",
              minHeight: 44,
              padding: "10px 12px",
              borderRadius: 8,
              border: `1px solid ${THEME.border}`,
              background: THEME.card,
              color: THEME.heading,
              fontSize: 16,
            }}
          />
        </label>
        <button
          type="button"
          onClick={() => void handleAiPick()}
          disabled={aiLoading || loading || items.length === 0}
          aria-label="Let AI pick the best saved image for this scene"
          title="Rank saved images against the scene text"
          style={{
            minHeight: 44,
            minWidth: 44,
            padding: "10px 16px",
            borderRadius: 8,
            border: "1px solid #E8E8E8",
            background: "#E8E8E8",
            color: "#000",
            fontSize: 15,
            fontWeight: 700,
            cursor: aiLoading ? "wait" : "pointer",
            opacity: aiLoading || loading ? 0.6 : 1,
          }}
        >
          {aiLoading ? "Ranking…" : "✨ AI pick"}
        </button>
      </div>

      {aiNote ? (
        <p role="status" style={{ margin: 0, fontSize: 13, color: THEME.muted }}>
          {aiNote}
        </p>
      ) : null}

      {loading ? (
        <SkeletonGrid />
      ) : !isSupabaseConfigured() ? (
        <div role="status" style={{ color: THEME.muted, lineHeight: 1.5 }}>
          <p style={{ margin: "0 0 8px" }}>
            Image library needs Supabase keys (NEXT_PUBLIC_SUPABASE_URL +
            NEXT_PUBLIC_SUPABASE_ANON_KEY). Generation still works.
          </p>
        </div>
      ) : items.length === 0 ? (
        <div
          role="status"
          style={{
            border: `1px dashed ${THEME.border}`,
            borderRadius: 8,
            padding: 24,
            textAlign: "center",
            color: THEME.muted,
            lineHeight: 1.5,
          }}
        >
          <p style={{ margin: "0 0 8px", color: THEME.heading }}>
            No saved images yet — upload one
          </p>
          <p style={{ margin: "0 0 12px", fontSize: 14 }}>
            Generated stills and uploads appear here once the{" "}
            <code>public.images</code> table exists (run
            supabase/migration_003_images_library.sql).
          </p>
          <a href="/create" style={{ color: THEME.heading }}>
            Generate or upload your first image →
          </a>
        </div>
      ) : ranked.length === 0 ? (
        <p role="status" style={{ margin: 0, color: THEME.muted }}>
          No matches for “{search}”. Try fewer words (e.g. “cave” instead of
          “glowing crystal cave at night”).
        </p>
      ) : (
        <ul
          aria-label="Saved images"
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
            gap: 12,
          }}
        >
          {ranked.map((item) => {
            const isSelected = item.id === selectedId;
            const isAiSuggested = item.id === aiPickId;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => onSelect(item)}
                  aria-pressed={isSelected}
                  aria-label={`Use saved image: ${item.description.slice(0, 80)}${isAiSuggested ? " (AI suggested)" : ""}`}
                  title={item.description}
                  style={{
                    display: "block",
                    width: "100%",
                    padding: 0,
                    borderRadius: 8,
                    overflow: "hidden",
                    cursor: "pointer",
                    border: `2px solid ${
                      isSelected
                        ? "#E8E8E8"
                        : isAiSuggested
                          ? "#8AB4FF"
                          : THEME.border
                    }`,
                    background: THEME.card,
                    position: "relative",
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={item.url}
                    alt={item.description}
                    loading="lazy"
                    style={{
                      width: "100%",
                      aspectRatio: "9 / 16",
                      objectFit: "cover",
                      display: "block",
                      background: "#000",
                    }}
                  />
                  {isAiSuggested ? (
                    <span
                      aria-hidden="true"
                      style={{
                        position: "absolute",
                        top: 6,
                        left: 6,
                        fontSize: 12,
                        fontWeight: 700,
                        background: "#8AB4FF",
                        color: "#000",
                        borderRadius: 999,
                        padding: "2px 8px",
                      }}
                    >
                      ✨ AI
                    </span>
                  ) : null}
                  <span
                    style={{
                      display: "block",
                      fontSize: 12,
                      color: THEME.muted,
                      padding: "6px 8px",
                      textAlign: "left",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {item.description || "Untitled"}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <style>{`.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }`}</style>
    </section>
  );
}
