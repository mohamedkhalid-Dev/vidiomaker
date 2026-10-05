/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  compress: true,
  // Deploy (frontend-only, Vercel): default server output (NOT "export") —
  // Next.js Route Handlers under src/app/api/* need the server runtime.
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "image.pollinations.ai",
      },
      // Supabase Storage (scene stills in uploads/, final MP4 posters).
      // Wildcard covers <project-ref>.supabase.co for any project.
      {
        protocol: "https",
        hostname: "*.supabase.co",
      },
    ],
  },
  // Video engine is Canvas 2D + MediaRecorder (no wasm, no SharedArrayBuffer),
  // so it deliberately needs NO cross-origin isolation — no COOP/COEP headers
  // here (Cross-Origin-Opener-Policy / Cross-Origin-Embedder-Policy). Adding
  // them would needlessly isolate the page and break third-party embeds.
};

export default nextConfig;
