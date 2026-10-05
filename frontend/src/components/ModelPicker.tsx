"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  MODEL_STORAGE_KEY,
  fetchOpenRouterModels,
  type OpenRouterModel,
} from "../lib/openrouter";
import { isRateLimitedMessage, toUserMessage } from "../lib/errors";
import ErrorAlert from "./ErrorAlert";

type ProviderTab = "openrouter" | "future";

interface ModelPickerProps {
  selectedModel?: string;
  onSelect?: (modelId: string) => void;
  /** Start expanded. Defaults to false so the wizard shows one simple line. */
  defaultOpen?: boolean;
}

const THEME = {
  background: "#000",
  text: "#B8B8B8",
  muted: "#808080",
  card: "#111",
  border: "#2A2A2A",
  button: "#1A1A1A",
  heading: "#D4D4D4",
} as const;

function getVendor(modelId: string): string {
  const parts = modelId.split("/");
  return parts.length > 1 ? parts[0] : "other";
}

function formatPerMillion(value: string | undefined): string {
  if (value === undefined || value === null || value === "") return "—";
  const num = Number(value);
  if (!Number.isFinite(num)) return "—";
  if (num === 0) return "$0";
  const perMillion = num * 1_000_000;
  if (perMillion >= 100) return `$${perMillion.toFixed(0)}`;
  if (perMillion >= 1) return `$${perMillion.toFixed(2)}`;
  return `$${perMillion.toFixed(4)}`;
}

function readPersistedModel(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(MODEL_STORAGE_KEY);
  } catch {
    return null;
  }
}

function LoadingSkeleton(): React.ReactElement {
  return (
    <div aria-busy="true" aria-label="Loading models" style={{ display: "grid", gap: 12 }}>
      {Array.from({ length: 6 }).map((_, index) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: skeleton placeholders only
          key={index}
          style={{
            minHeight: 64,
            borderRadius: 8,
            border: `1px solid ${THEME.border}`,
            background: `linear-gradient(90deg, ${THEME.card} 25%, #1c1c1c 50%, ${THEME.card} 75%)`,
            backgroundSize: "200% 100%",
            animation: "vidiomaker-pulse 1.4s ease-in-out infinite",
          }}
        />
      ))}
      <style>{`@keyframes vidiomaker-pulse { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }`}</style>
    </div>
  );
}

export default function ModelPicker({ selectedModel, onSelect, defaultOpen = false }: ModelPickerProps): React.ReactElement {
  const [activeTab, setActiveTab] = useState<ProviderTab>("openrouter");
  const [models, setModels] = useState<OpenRouterModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [internalSelected, setInternalSelected] = useState<string | null>(null);
  // Vendor accordion: click a vendor header to open/close its models.
  // Stored as a list (not a Set) so it stays serializable + React-friendly.
  const [expandedVendors, setExpandedVendors] = useState<string[]>([]);
  // Expanded model details (description). Selecting a model also opens it.
  const [expandedModel, setExpandedModel] = useState<string | null>(null);

  // Hydrate persisted selection on mount (avoids SSR/localStorage mismatch).
  useEffect(() => {
    setInternalSelected(readPersistedModel());
  }, []);

  const effectiveSelected = selectedModel ?? internalSelected;

  const loadModels = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await fetchOpenRouterModels();
      const sorted = [...list].sort((a, b) => a.name.localeCompare(b.name));
      setModels(sorted);
    } catch (err) {
      // Network failures become the retry hint; 401/429 pass through with
      // actionable text (ErrorAlert adds the Settings link / countdown).
      setError(
        toUserMessage(
          err,
          "Could not load models. Please check your connection and retry."
        )
      );
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch when the OpenRouter tab is opened.
  useEffect(() => {
    if (activeTab === "openrouter" && models.length === 0 && !loading && !error) {
      void loadModels();
    }
  }, [activeTab, models.length, loading, error, loadModels]);

  const handleSelect = useCallback(
    (modelId: string) => {
      setInternalSelected(modelId);
      // Clicking a model selects it AND opens its details.
      setExpandedModel((prev) => (prev === modelId ? prev : modelId));
      try {
        window.localStorage.setItem(MODEL_STORAGE_KEY, modelId);
      } catch {
        // Storage may be unavailable (private mode); selection still works in-memory.
      }
      onSelect?.(modelId);
    },
    [onSelect]
  );

  function toggleVendor(vendor: string): void {
    setExpandedVendors((prev) =>
      prev.includes(vendor) ? prev.filter((v) => v !== vendor) : [...prev, vendor]
    );
  }

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return models;
    return models.filter(
      (model) =>
        model.id.toLowerCase().includes(query) ||
        model.name.toLowerCase().includes(query)
    );
  }, [models, search]);

  const grouped = useMemo(() => {
    const map = new Map<string, OpenRouterModel[]>();
    for (const model of filtered) {
      const vendor = getVendor(model.id);
      const existing = map.get(vendor);
      if (existing) {
        existing.push(model);
      } else {
        map.set(vendor, [model]);
      }
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  const isSearching = search.trim().length > 0;

  // Auto-open the vendor that holds the saved selection on first load,
  // so the user sees their current model without hunting.
  useEffect(() => {
    if (models.length === 0 || expandedVendors.length > 0) return;
    const selected = selectedModel ?? readPersistedModel();
    if (selected) {
      const vendor = getVendor(selected);
      if (vendor) setExpandedVendors([vendor]);
    }
    // Run once per model list load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models.length]);

  // While searching, all matching vendors stay open — otherwise the
  // results would stay hidden inside collapsed groups.
  const isVendorOpen = useCallback(
    (vendor: string): boolean => {
      if (isSearching) return true;
      return expandedVendors.includes(vendor);
    },
    [isSearching, expandedVendors]
  );

  function expandAllVendors(): void {
    setExpandedVendors(grouped.map(([vendor]) => vendor));
  }

  function collapseAllVendors(): void {
    setExpandedVendors([]);
  }

  const tabButtonStyle = (active: boolean): React.CSSProperties => ({
    flex: 1,
    minHeight: 44,
    padding: "12px 16px",
    borderRadius: 8,
    border: `1px solid ${THEME.border}`,
    background: active ? "#2A2A2A" : THEME.button,
    color: active ? THEME.heading : THEME.text,
    fontWeight: active ? 700 : 400,
    cursor: "pointer",
    fontSize: 16,
  });

  const summaryText = effectiveSelected
    ? `Writing model ✓ ${effectiveSelected}`
    : "Writing model (required) — pick one";

  return (
    <section
      aria-label="Writing model picker"
      style={{
        background: THEME.background,
        color: THEME.text,
        border: `1px solid ${THEME.border}`,
        borderRadius: 12,
        padding: 16,
        width: "100%",
        maxWidth: 720,
        boxSizing: "border-box",
      }}
    >
      <details open={defaultOpen} style={{ display: "grid", gap: 12 }}>
        <summary
          style={{
            cursor: "pointer",
            minHeight: 44,
            display: "flex",
            alignItems: "center",
            color: THEME.heading,
            fontWeight: 600,
            fontSize: 16,
            wordBreak: "break-all",
          }}
        >
          {summaryText}
        </summary>
      <p style={{ color: THEME.muted, margin: "8px 0 0", fontSize: 14, lineHeight: 1.5 }}>
        The AI that writes your script. The saved choice is reused
        automatically — open to change it.
      </p>

      <div role="tablist" aria-label="Providers" style={{ display: "flex", gap: 8, marginBottom: 16, marginTop: 12 }}>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "openrouter"}
          onClick={() => setActiveTab("openrouter")}
          style={tabButtonStyle(activeTab === "openrouter")}
        >
          OpenRouter
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "future"}
          onClick={() => setActiveTab("future")}
          style={tabButtonStyle(activeTab === "future")}
        >
          More providers (soon)
        </button>
      </div>

      {activeTab === "future" ? (
        <p style={{ color: THEME.muted, minHeight: 44, margin: 0, lineHeight: "44px" }}>
          Additional providers will appear here in a future update.
        </p>
      ) : (
        <div>
          <label htmlFor="model-search" style={{ display: "block", marginBottom: 8, fontSize: 14 }}>
            Search models
          </label>
          <input
            id="model-search"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by name or id…"
            autoComplete="off"
            style={{
              width: "100%",
              minHeight: 44,
              padding: "10px 12px",
              borderRadius: 8,
              border: `1px solid ${THEME.border}`,
              background: THEME.card,
              color: THEME.text,
              fontSize: 16,
              boxSizing: "border-box",
            }}
          />

          <div style={{ marginTop: 16 }}>
            {loading ? (
              <LoadingSkeleton />
            ) : error ? (
              <ErrorAlert
                message={error}
                onRetry={() => void loadModels()}
                retryLabel="Retry"
                autoRetry={isRateLimitedMessage(error)}
              />
            ) : filtered.length === 0 ? (
              <p style={{ color: THEME.muted, minHeight: 44 }}>
                {models.length === 0
                  ? "No models loaded yet."
                  : "No models match your search."}
              </p>
            ) : (
              <div style={{ display: "grid", gap: 20 }}>
                {!isSearching && grouped.length > 1 ? (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      onClick={expandAllVendors}
                      style={{
                        minHeight: 44,
                        padding: "8px 14px",
                        borderRadius: 8,
                        border: `1px solid ${THEME.border}`,
                        background: THEME.button,
                        color: THEME.text,
                        fontSize: 14,
                        cursor: "pointer",
                      }}
                    >
                      Expand all
                    </button>
                    <button
                      type="button"
                      onClick={collapseAllVendors}
                      style={{
                        minHeight: 44,
                        padding: "8px 14px",
                        borderRadius: 8,
                        border: `1px solid ${THEME.border}`,
                        background: THEME.button,
                        color: THEME.text,
                        fontSize: 14,
                        cursor: "pointer",
                      }}
                    >
                      Collapse all
                    </button>
                  </div>
                ) : null}
                {grouped.map(([vendor, vendorModels]) => {
                  const open = isVendorOpen(vendor);
                  const selectedInVendor = effectiveSelected
                    ? vendorModels.some((m) => m.id === effectiveSelected)
                    : false;
                  return (
                  <div
                    key={vendor}
                    style={{
                      border: `1px solid ${THEME.border}`,
                      borderRadius: 8,
                      overflow: "hidden",
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => toggleVendor(vendor)}
                      aria-expanded={open}
                      aria-controls={`vendor-models-${vendor}`}
                      style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 8,
                        minHeight: 44,
                        padding: "12px 14px",
                        background: selectedInVendor ? "#1E1E1E" : THEME.card,
                        color: THEME.heading,
                        fontSize: 16,
                        fontWeight: 600,
                        textTransform: "capitalize",
                        cursor: "pointer",
                        border: "none",
                        textAlign: "left",
                      }}
                    >
                      <span>
                        {open ? "▼" : "▶"} {vendor} ({vendorModels.length})
                        {selectedInVendor ? " • selected ✓" : ""}
                      </span>
                    </button>
                    {open ? (
                    <ul
                      id={`vendor-models-${vendor}`}
                      style={{ listStyle: "none", margin: 0, padding: 12, display: "grid", gap: 8 }}
                    >
                      {vendorModels.map((model) => {
                        const isSelected = effectiveSelected === model.id;
                        const detailsOpen = expandedModel === model.id;
                        return (
                          <li key={model.id}>
                            <button
                              type="button"
                              onClick={() => handleSelect(model.id)}
                              aria-pressed={isSelected}
                              title="Click to select this model — click again to open details"
                              style={{
                                width: "100%",
                                textAlign: "left",
                                minHeight: 44,
                                padding: "12px",
                                borderRadius: 8,
                                border: `1px solid ${isSelected ? THEME.heading : THEME.border}`,
                                background: isSelected ? "#1E1E1E" : THEME.button,
                                color: THEME.text,
                                cursor: "pointer",
                              }}
                            >
                              <span
                                style={{
                                  display: "block",
                                  color: THEME.heading,
                                  fontWeight: 600,
                                  fontSize: 15,
                                  marginBottom: 4,
                                }}
                              >
                                {model.name}
                                {isSelected ? " ✓" : ""}
                              </span>
                              <span style={{ display: "block", fontSize: 13, color: THEME.muted, wordBreak: "break-all" }}>
                                {model.id}
                              </span>
                              <span
                                style={{
                                  display: "flex",
                                  flexWrap: "wrap",
                                  gap: 12,
                                  marginTop: 6,
                                  fontSize: 13,
                                  color: THEME.muted,
                                }}
                              >
                                <span>
                                  Context:{" "}
                                  {typeof model.context_length === "number"
                                    ? model.context_length.toLocaleString()
                                    : "—"}
                                </span>
                                <span>
                                  In: {formatPerMillion(model.pricing?.prompt)}/1M
                                </span>
                                <span>
                                  Out: {formatPerMillion(model.pricing?.completion)}/1M
                                </span>
                              </span>
                              {detailsOpen && model.description ? (
                                <span
                                  style={{
                                    display: "block",
                                    marginTop: 8,
                                    fontSize: 13,
                                    lineHeight: 1.5,
                                    color: THEME.text,
                                  }}
                                >
                                  {model.description.slice(0, 300)}
                                  {model.description.length > 300 ? "…" : ""}
                                </span>
                              ) : null}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                    ) : null}
                  </div>
                  );
                })}
              </div>
            )}
          </div>

          {effectiveSelected ? (
            <p style={{ marginTop: 16, fontSize: 13, color: THEME.muted, wordBreak: "break-all" }}>
              Using: {effectiveSelected}
            </p>
          ) : (
            <p role="note" style={{ marginTop: 16, fontSize: 14, color: "#D4A0A0" }}>
              No model picked yet — search below and tap one to select it.
            </p>
          )}
        </div>
      )}
      </details>
    </section>
  );
}
