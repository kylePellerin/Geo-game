/**
 * Picture matching rounds: which variants show an image on the left, and how it is drawn.
 * Images are served by display position (/api/image/<date>/<idx>/<pos>), never by country, so the
 * URL doesn't give the answer away.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type ImageKind = "flag" | "outline" | "map";

export const IMAGE_VARIANTS: Record<string, ImageKind> = {
  match_flag_country: "flag",
  match_flag_capital: "flag",
  match_outline_country: "outline",
  match_map_country: "map",
};

/** Admin "show left items as" choice <-> variant, for custom rounds (they match to countries). */
export const DISPLAY_VARIANTS = {
  flags: "match_flag_country", outlines: "match_outline_country", maps: "match_map_country",
} as const;
export type Display = keyof typeof DISPLAY_VARIANTS | "names";
export const displayOf = (variant?: string): Display =>
  (Object.entries(DISPLAY_VARIANTS).find(([, v]) => v === variant)?.[0] as Display) ?? "names";

export const imageKind = (variant?: string): ImageKind | null =>
  (variant && IMAGE_VARIANTS[variant]) || null;

const FLAG_DIR = join(process.cwd(), "node_modules", "flag-icons", "flags", "4x3");

const json = <T>(file: string) => {
  let p: Promise<T> | null = null;
  return () => (p ??= readFile(join(process.cwd(), "data", file), "utf8").then(JSON.parse));
};
const outlines = json<Record<string, { d: string; w: number; h: number }>>("outlines.json");
const locators = json<Record<string, { rows: string[]; dot: [number, number] | null }>>("locators.json");

/** Locator map colours: pixel-world palette, the country in red. */
const MAP_COLORS: Record<string, string> = {
  ".": "#2a5fa8", ",": "#3f7fcf", l: "#8fbf5a", k: "#5f8f3c", x: "#ff5a5f",
};
const PX = 10;

export function locatorSvg(rows: string[], dot: [number, number] | null): string {
  const w = rows[0].length;
  const h = rows.length;
  const rects: string[] = [];
  rows.forEach((row, y) => {
    let x = 0;
    while (x < w) {
      const ch = row[x];
      let end = x + 1;
      while (end < w && row[end] === ch) end++;
      rects.push(`<rect x="${x}" y="${y}" width="${end - x}" height="1" fill="${MAP_COLORS[ch] ?? MAP_COLORS["."]}"/>`);
      x = end;
    }
  });
  // the country's own edge: a darker red outline drawn on the cells around it
  rows.forEach((row, y) => [...row].forEach((ch, x) => {
    if (ch !== "x") return;
    const out = (dx: number, dy: number) => rows[y + dy]?.[x + dx] !== "x";
    if (out(0, -1) || out(0, 1) || out(-1, 0) || out(1, 0)) {
      rects.push(`<rect x="${x}" y="${y}" width="1" height="1" fill="#c0303a" opacity="0.55"/>`);
    }
  }));
  if (dot) {
    const [cx, cy] = dot;
    // a pixel ring around countries too small to see
    for (const [dx, dy] of [[-2, -1], [-2, 0], [-2, 1], [2, -1], [2, 0], [2, 1], [-1, -2], [0, -2], [1, -2], [-1, 2], [0, 2], [1, 2]]) {
      rects.push(`<rect x="${cx + dx}" y="${cy + dy}" width="1" height="1" fill="#fff"/>`);
    }
    rects.push(`<rect x="${cx}" y="${cy}" width="1" height="1" fill="#ff5a5f"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w * PX}" height="${h * PX}" shape-rendering="crispEdges">${rects.join("")}</svg>`;
}

/** The SVG for a country (by ISO alpha-2) in the given image kind, or null if there is none. */
export async function countryImage(kind: ImageKind, iso2: string): Promise<string | null> {
  if (!/^[A-Z]{2}$/.test(iso2)) return null;
  if (kind === "flag") {
    const svg = await readFile(join(FLAG_DIR, `${iso2.toLowerCase()}.svg`), "utf8").catch(() => null);
    // strip the id attribute ("flag-icons-fr"), which would name the country
    return svg?.replace(/\sid="[^"]*"/, "") ?? null;
  }
  if (kind === "outline") {
    const o = (await outlines())[iso2];
    return o ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${o.w} ${o.h}" width="${o.w}" height="${o.h}">` +
      `<path d="${o.d}" fill="#444"/></svg>` : null;
  }
  const l = (await locators())[iso2];
  return l ? locatorSvg(l.rows, l.dot) : null;
}
