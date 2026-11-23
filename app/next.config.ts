import type { NextConfig } from "next";

/** Basic hardening headers; the game loads nothing from other sites except Google Fonts (inlined by next/font). */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // The image route reads these at runtime by computed path (lib/game/images.ts), which file
  // tracing can't see: without this, picture rounds would 404 on Vercel.
  outputFileTracingIncludes: {
    "/api/image/**": ["./data/outlines.json", "./data/locators.json", "./node_modules/flag-icons/flags/4x3/*.svg"],
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
