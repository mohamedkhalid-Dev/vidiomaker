import type { Metadata } from "next";
import SettingsApiKey, { SettingsPrefs } from "../../components/SettingsApiKey";
import SettingsCloudflare from "../../components/SettingsCloudflare";
import SettingsCustomInstructions from "../../components/SettingsCustomInstructions";

export const metadata: Metadata = {
  title: "Settings",
  description:
    "Add your OpenRouter API key, test the connection and set the default AI model, image style and vertical aspect for faster Shorts, Reels and TikTok renders.",
  robots: { index: true, follow: true },
  openGraph: {
    title: "Settings",
    description:
      "Manage your OpenRouter key, test the connection and set default AI model, image style and vertical video preferences.",
    images: [{ url: "/og-image.svg", width: 1200, height: 630, alt: "Vidiomaker — Settings" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Settings",
    description:
      "Manage your OpenRouter key, test the connection and set default AI model, image style and vertical video preferences.",
    images: ["/og-image.svg"],
  },
  alternates: { canonical: "/settings" },
};

/**
 * /settings — server component (SEO metadata) rendering client islands.
 * Grouped into 3 sections: 1 API Key · 2 Images · 3 Defaults.
 * Black/grey theme, responsive mobile-first (single column, ≥44px targets).
 */
export default function SettingsPage(): React.ReactElement {
  const h2: React.CSSProperties = { color: "#D4D4D4", margin: "0 0 4px", fontSize: 18 };
  const sub: React.CSSProperties = { color: "#808080", margin: "0 0 12px", fontSize: 14, lineHeight: 1.6 };
  return (
    <section
      aria-label="Settings"
      style={{
        background: "#000",
        color: "#B8B8B8",
        display: "grid",
        gap: 20,
        width: "100%",
        maxWidth: 760,
        margin: "0 auto",
        padding: "8px 0 32px",
      }}
    >
      <div>
        <h1 style={{ color: "#D4D4D4", margin: "0 0 8px", fontSize: 24 }}>Settings</h1>
        <p style={{ color: "#808080", margin: 0, fontSize: 15, lineHeight: 1.6 }}>
          Three quick sections — key, images, defaults. Everything stays in this
          browser unless noted.
        </p>
      </div>
      <div aria-label="1 — API Key" style={{ display: "grid", gap: 12 }}>
        <h2 style={h2}>1 — API Key</h2>
        <p style={sub}>Paste once, Test &amp; Save, then generate.</p>
        <SettingsApiKey />
      </div>
      <div aria-label="2 — Images" style={{ display: "grid", gap: 12 }}>
        <h2 style={h2}>2 — Images</h2>
        <p style={sub}>Server-side Cloudflare status — no key to paste here.</p>
        <SettingsCloudflare />
      </div>
      <div aria-label="3 — Defaults" style={{ display: "grid", gap: 12 }}>
        <h2 style={h2}>3 — Defaults</h2>
        <p style={sub}>Model, aspect, and creative defaults for new videos.</p>
        <SettingsPrefs />
        <SettingsCustomInstructions />
      </div>
      <p style={{ color: "#808080", fontSize: 13, margin: 0, lineHeight: 1.6 }}>
        Keys are sent per request via POST body / Authorization header only — never in URLs —
        and are stored only in this browser (no server copy). Clearing removes the key from this browser.
      </p>
    </section>
  );
}
