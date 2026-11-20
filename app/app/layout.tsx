import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, DM_Mono, Fraunces } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";

const display = Fraunces({
  subsets: ["latin"], variable: "--f-display", axes: ["SOFT", "WONK", "opsz"], display: "swap",
});
const ui = Bricolage_Grotesque({ subsets: ["latin"], variable: "--f-ui", display: "swap" });
const mono = DM_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--f-mono", display: "swap" });

export const metadata: Metadata = {
  title: "Geo-rarity",
  description: "A daily geography game: the rarer your right answer, the more it scores.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#0d1a29" };

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className={`${display.variable} ${ui.variable} ${mono.variable}`}>
      <body>
        {/* rubber-stamp ink: roughens the edges of .stamp */}
        <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
          <filter id="ink-rough" x="-5%" y="-5%" width="110%" height="110%">
            <feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="2" seed="7" result="noise" />
            <feDisplacementMap in="SourceGraphic" in2="noise" scale="1.6" result="rough" />
            <feTurbulence type="fractalNoise" baseFrequency="0.55" numOctaves="1" seed="3" result="speck" />
            <feColorMatrix in="speck" type="matrix"
                           values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -1.6 1.95" result="mask" />
            <feComposite in="rough" in2="mask" operator="in" />
          </filter>
        </svg>
        {children}
      </body>
    </html>
  );
}
