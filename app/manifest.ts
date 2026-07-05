import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "vibe-shelf — vinyl catalogue",
    short_name: "vibe-shelf",
    description: "Search a shared vinyl collection by artist, style, and vibe.",
    start_url: "/",
    display: "standalone",
    background_color: "#0f120d",
    theme_color: "#0f120d",
    icons: [
      // Both `any` and `maskable` so launchers that crop to a circle use the
      // full-bleed art, and contexts that don't still render it.
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
