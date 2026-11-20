/** GET /api/results/:date → the player's results for that date and the share text. */
import { NextResponse, type NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { GameError } from "@/lib/game/answer";
import { gameToday, isIsoDate, withPlayer } from "@/lib/game/http";
import { getResults } from "@/lib/game/results";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ date: string }> }) {
  return withPlayer(req, async (playerId) => {
    const { date } = await ctx.params;
    if (!isIsoDate(date) || date > gameToday()) throw new GameError("bad_date", "No such date", 404);
    const results = await getResults(getPool(), playerId, date, gameToday());
    if (!results) throw new GameError("no_puzzle", "No puzzle for that date", 404);
    return NextResponse.json(results);
  });
}
