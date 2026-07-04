import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "vibe-shelf",
    short_name: "vibe-shelf",
    description: "A private, vibe-aware catalogue of a shared vinyl shelf.",
    start_url: "/",
    display: "standalone",
    background_color: "#17181b",
    theme_color: "#17181b",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ],
  };
}
