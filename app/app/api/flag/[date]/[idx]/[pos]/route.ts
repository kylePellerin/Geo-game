/**
 * GET /api/flag/:date/:idx/:pos → the flag SVG at display position `pos` of a flag matching
 * round. The URL names a position, not a country, so it doesn't give the answer away.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { gameToday, isIsoDate } from "@/lib/game/http";
import { loadPuzzle } from "@/lib/game/puzzle";

export const dynamic = "force-dynamic";

const FLAG_DIR = join(process.cwd(), "node_modules", "flag-icons", "flags", "4x3");

export async function GET(
  _req: NextRequest, ctx: { params: Promise<{ date: string; idx: string; pos: string }> },
) {
  const { date, idx, pos } = await ctx.params;
  const notFound = () => new NextResponse("Not found", { status: 404 });
  if (!isIsoDate(date) || date > gameToday()) return notFound();
  const q = (await loadPuzzle(getPool(), date))?.find((x) => x.idx === Number(idx));
  const pair = q?.variant === "match_flag_country" ? q.pairs[Number(pos)] : undefined;
  if (!pair) return notFound();
  const { rows } = await getPool().query<{ iso2: string }>(
    "SELECT attrs->>'iso2' AS iso2 FROM entities WHERE id = $1", [pair.left],
  );
  const iso2 = rows[0]?.iso2?.toLowerCase();
  if (!iso2 || !/^[a-z]{2}$/.test(iso2)) return notFound();
  const svg = await readFile(join(FLAG_DIR, `${iso2}.svg`), "utf8").catch(() => null);
  if (!svg) return notFound();
  // strip the id attribute ("flag-icons-fr"), which would name the country
  return new NextResponse(svg.replace(/\sid="[^"]*"/, ""), {
    headers: { "Content-Type": "image/svg+xml", "Cache-Control": "private, max-age=86400" },
  });
}
