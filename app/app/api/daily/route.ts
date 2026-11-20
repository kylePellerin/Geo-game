/**
 * GET /api/daily[?date=YYYY-MM-DD] → today's (or a past) puzzle without answers, plus the
 * player's progress. Future puzzles are never served.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { GameError } from "@/lib/game/answer";
import { gameToday, isIsoDate, withPlayer } from "@/lib/game/http";
import { loadPuzzle, publicQuestions } from "@/lib/game/puzzle";
import { getResults } from "@/lib/game/results";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return withPlayer(req, async (playerId) => {
    const today = gameToday();
    const date = req.nextUrl.searchParams.get("date") ?? today;
    if (!isIsoDate(date)) throw new GameError("bad_date", "Use a YYYY-MM-DD date");
    if (date > today) throw new GameError("not_released", "That puzzle isn't out yet", 404);
    const db = getPool();
    const puzzle = await loadPuzzle(db, date);
    if (!puzzle) throw new GameError("no_puzzle", "No puzzle for that date", 404);
    const results = await getResults(db, playerId, date);
    return NextResponse.json({
      date,
      isToday: date === today,
      questions: await publicQuestions(db, puzzle),
      progress: results?.questions.filter((q) => q.answered).map((q) => ({
        idx: q.idx, status: q.status, points: q.points, answer: q.answer, tier: q.tier,
      })) ?? [],
    });
  });
}
