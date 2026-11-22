/**
 * GET /api/image/:date/:idx/:pos → the picture (flag, outline or locator map) at display position
 * `pos` of a picture matching round. The URL names a position, never a country.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { gameToday, isIsoDate } from "@/lib/game/http";
import { countryImage, imageKind } from "@/lib/game/images";
import { loadPuzzle } from "@/lib/game/puzzle";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest, ctx: { params: Promise<{ date: string; idx: string; pos: string }> },
) {
  const { date, idx, pos } = await ctx.params;
  const notFound = () => new NextResponse("Not found", { status: 404 });
  if (!isIsoDate(date) || date > gameToday()) return notFound();
  const q = (await loadPuzzle(getPool(), date))?.find((x) => x.idx === Number(idx));
  const kind = imageKind(q?.variant);
  const pair = kind ? q!.pairs[Number(pos)] : undefined;
  if (!kind || !pair) return notFound();
  const { rows } = await getPool().query<{ iso2: string }>(
    "SELECT attrs->>'iso2' AS iso2 FROM entities WHERE id = $1", [pair.left],
  );
  const svg = rows[0]?.iso2 ? await countryImage(kind, rows[0].iso2) : null;
  if (!svg) return notFound();
  return new NextResponse(svg, {
    headers: { "Content-Type": "image/svg+xml", "Cache-Control": "private, max-age=86400" },
  });
}
