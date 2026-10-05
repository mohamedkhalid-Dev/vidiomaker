import type { Metadata } from "next";
import HistoryList from "../../components/HistoryList";
import VideoLibrary from "../../components/VideoLibrary";

export const metadata: Metadata = {
  title: "Video history",
  description:
    "Browse every AI video you generated — scene stills, prompts, seeds, MP4 previews and downloads. Regenerate any single scene without a full rebuild.",
  robots: { index: true, follow: true },
  openGraph: {
    title: "Video history",
    description:
      "All your AI vertical videos in one place — stills, prompts, seeds, MP4 previews, downloads and single-scene regeneration.",
    images: [{ url: "/og-image.svg", width: 1200, height: 630, alt: "Vidiomaker — Video history" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Video history",
    description:
      "All your AI vertical videos in one place — stills, prompts, seeds, MP4 previews, downloads and single-scene regeneration.",
    images: ["/og-image.svg"],
  },
  alternates: { canonical: "/history" },
};

/**
 * /history — server component (SEO metadata) rendering the HistoryList
 * client island. Black/grey theme, responsive, lazy previews.
 */
export default function HistoryPage(): React.ReactElement {
  return (
    <section
      aria-label="Video history"
      style={{
        background: "#000",
        color: "#B8B8B8",
        display: "grid",
        gap: 16,
        width: "100%",
        maxWidth: 960,
        margin: "0 auto",
        padding: "8px 0 32px",
      }}
    >
      <div>
        <h1 style={{ color: "#D4D4D4", margin: "0 0 8px", fontSize: 24 }}>History</h1>
        <p style={{ color: "#808080", margin: 0, fontSize: 15, lineHeight: 1.6 }}>
          Upload videos straight to Supabase (no backend), then download or
          delete them anytime. AI renders appear below.
        </p>
      </div>
      <VideoLibrary />
      <HistoryList />
    </section>
  );
}
