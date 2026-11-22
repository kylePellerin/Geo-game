/**
 * GET /api/leaderboard/:date → the day's top players and the asking player's own rank.
 * :date may be "today" or "yesterday" (the server's game date).
 */
import { NextResponse, type NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { gameToday, isIsoDate, withPlayer } from "@/lib/game/http";
import { leaderboard } from "@/lib/game/leaderboard";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ date: string }> }) {
  const raw = (await ctx.params).date;
  const today = gameToday();
  const date = raw === "today" ? today
    : raw === "yesterday" ? new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
    : raw;
  if (!isIsoDate(date) || date > today) {
    return NextResponse.json({ error: "bad_date", message: "No such day" }, { status: 404 });
  }
  return withPlayer(req, async (playerId) => NextResponse.json(await leaderboard(getPool(), date, playerId)));
}
