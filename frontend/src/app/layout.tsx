import type { Metadata, Viewport } from "next";
import Link from "next/link";
import SiteHeader from "../components/SiteHeader";
import "./globals.css";

const SITE_URL = "https://vidiomaker.app";
const SITE_NAME = "Vidiomaker";
const SITE_DESCRIPTION =
  "Vidiomaker turns words and pictures into vertical AI videos — OpenRouter scripts, Cloudflare FLUX stills and Canvas Ken Burns Shorts, Reels, TikToks.";
const OG_IMAGE = "/og-image.svg";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Vidiomaker — AI Video Studio",
    template: "%s — Vidiomaker",
  },
  description: SITE_DESCRIPTION,
  keywords: [
    "AI video generator",
    "AI video studio",
    "text to video",
    "vertical video maker",
    "OpenRouter",
    "Cloudflare FLUX",
    "Canvas Ken Burns",
    "Shorts",
    "Reels",
    "TikTok",
  ],
  authors: [{ name: SITE_NAME }],
  creator: SITE_NAME,
  publisher: SITE_NAME,
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    url: SITE_URL,
    title: "Vidiomaker — AI Video Studio",
    description:
      "Type words or upload pictures to get OpenRouter scripts, Cloudflare FLUX stills and Canvas vertical videos for Shorts, Reels and TikTok.",
    locale: "en_US",
    images: [{ url: OG_IMAGE, width: 1200, height: 630, alt: "Vidiomaker — AI Video Studio" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Vidiomaker — AI Video Studio",
    description:
      "Words in, vertical video out: OpenRouter script, FLUX stills and Ken Burns animation for Shorts, Reels, TikTok.",
    images: [OG_IMAGE],
  },
  icons: { icon: "/favicon.ico", apple: "/favicon.ico" },
  category: "technology",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#000000",
  colorScheme: "dark",
};

export default function RootLayout({
  children
}: {
  children: React.ReactNode;
}) {
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "SoftwareApplication",
        name: SITE_NAME,
        url: SITE_URL,
        applicationCategory: "MultimediaApplication",
        operatingSystem: "Web",
        description: SITE_DESCRIPTION,
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      },
      {
        "@type": "WebSite",
        name: SITE_NAME,
        url: SITE_URL,
        inLanguage: "en",
      },
    ],
  };
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
        <a href="#main-content" className="skip-link">
          Skip to main content
        </a>
        {/* Static header (not sticky): simpler, never covers content. */}
        <SiteHeader />
        <main id="main-content" tabIndex={-1}>{children}</main>
        <footer className="site-footer">
          <nav aria-label="Footer navigation">
            <Link href="/create">Create a video</Link>
            {" · "}
            <Link href="/history">Video history</Link>
            {" · "}
            <Link href="/settings">Settings</Link>
            {" · "}
            <Link href="/login">Log in</Link>
            {" · "}
            <Link href="/signup">Sign up</Link>
          </nav>
          <p>Vidiomaker — words in, vertical video out. Scripts via OpenRouter, stills via Cloudflare Workers AI, motion via Canvas.</p>
        </footer>
      </body>
    </html>
  );
}
