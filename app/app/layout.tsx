import type { Metadata, Viewport } from "next";
import { Pixelify_Sans, Silkscreen, VT323 } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";

// all three are SIL Open Font License (free for commercial use)
const display = Pixelify_Sans({ subsets: ["latin"], variable: "--f-display", display: "swap" });
const label = Silkscreen({ subsets: ["latin"], weight: ["400", "700"], variable: "--f-label", display: "swap" });
const mono = VT323({ subsets: ["latin"], weight: "400", variable: "--f-mono", display: "swap" });

export const metadata: Metadata = {
  title: "Geo-rarity",
  description: "A daily geography game: the rarer your right answer, the more it scores.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#0b1630" };

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className={`${display.variable} ${label.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
