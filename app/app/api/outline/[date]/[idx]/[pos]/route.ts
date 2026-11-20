/**
 * GET /api/outline/:date/:idx/:pos → the country outline (SVG) at display position `pos` of an
 * outline matching round. Like /api/flag, the URL names a position, never a country.
 * Outlines: app/data/outlines.json, built from Natural Earth by geo_pipeline.ingest.shapes.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { gameToday, isIsoDate } from "@/lib/game/http";
import { loadPuzzle } from "@/lib/game/puzzle";

export const dynamic = "force-dynamic";

type Outlines = Record<string, { d: string; w: number; h: number }>;
let outlines: Promise<Outlines> | null = null;
const loadOutlines = () =>
  (outlines ??= readFile(join(process.cwd(), "data", "outlines.json"), "utf8").then(JSON.parse));

export async function GET(
  _req: NextRequest, ctx: { params: Promise<{ date: string; idx: string; pos: string }> },
) {
  const { date, idx, pos } = await ctx.params;
  const notFound = () => new NextResponse("Not found", { status: 404 });
  if (!isIsoDate(date) || date > gameToday()) return notFound();
  const q = (await loadPuzzle(getPool(), date))?.find((x) => x.idx === Number(idx));
  const pair = q?.variant === "match_outline_country" ? q.pairs[Number(pos)] : undefined;
  if (!pair) return notFound();
  const { rows } = await getPool().query<{ iso2: string }>(
    "SELECT attrs->>'iso2' AS iso2 FROM entities WHERE id = $1", [pair.left],
  );
  const o = rows[0]?.iso2 ? (await loadOutlines())[rows[0].iso2] : undefined;
  if (!o) return notFound();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${o.w} ${o.h}" width="${o.w}" height="${o.h}">` +
    `<path d="${o.d}" fill="#444"/></svg>`;
  return new NextResponse(svg, {
    headers: { "Content-Type": "image/svg+xml", "Cache-Control": "private, max-age=86400" },
  });
}
