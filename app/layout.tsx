import type { Metadata, Viewport } from "next";
import { Space_Grotesk, Inter } from "next/font/google";
import "./globals.css";

// Self-hosted at build time by next/font, so no external font request at runtime
// (keeps CSP font-src 'self').
const display = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});
const body = Inter({
  subsets: ["latin"],
  variable: "--font-body",
  display: "swap",
});

export const metadata: Metadata = {
  title: "vibe-shelf",
  description: "Search a shared vinyl collection by artist, style, and vibe.",
  robots: { index: false, follow: false },
  manifest: "/manifest.webmanifest",
  icons: {
    // Browser tab uses the SVG; iOS home screen uses the full-bleed PNG (iOS
    // rounds the corners itself, so the file stays full-bleed, no transparency).
    icon: "/icon.svg",
    apple: "/apple-touch-icon.png",
  },
  appleWebApp: {
    capable: true,
    title: "vibe-shelf",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  themeColor: "#17191b",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <body>{children}</body>
    </html>
  );
}
