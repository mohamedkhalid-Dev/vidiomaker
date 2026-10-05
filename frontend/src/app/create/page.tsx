import type { Metadata } from "next";
import CreatePage from "../page";

export const metadata: Metadata = {
  title: "Create a video",
  description:
    "Type words or upload pictures to create AI vertical videos — OpenRouter scripts, Cloudflare FLUX stills and Canvas Ken Burns Shorts, Reels, TikToks.",
  robots: { index: true, follow: true },
  openGraph: {
    title: "Create a video",
    description:
      "Words in, vertical video out: OpenRouter script, FLUX stills and Ken Burns animation for Shorts, Reels and TikTok.",
    images: [{ url: "/og-image.svg", width: 1200, height: 630, alt: "Vidiomaker — Create a video" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Create a video",
    description:
      "Words in, vertical video out: OpenRouter script, FLUX stills and Ken Burns animation for Shorts, Reels and TikTok.",
    images: ["/og-image.svg"],
  },
  alternates: { canonical: "/create" },
};

/**
 * /create — clean-URL alias of the 4-step wizard that also lives at `/`.
 * The wizard itself stays in `app/page.tsx`; this route only adds SEO
 * metadata + a canonical URL so both paths render the same component
 * without duplicating logic (DRY).
 */
export default function CreateRoute(): React.ReactElement {
  return <CreatePage />;
}
