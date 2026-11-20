import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Geo-rarity",
  description: "A daily geography game: the rarer your right answer, the more it scores.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body style={{ maxWidth: "40rem", margin: "0 auto", padding: "0 1rem", fontFamily: "system-ui, sans-serif" }}>
        {children}
      </body>
    </html>
  );
}
