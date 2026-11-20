/**
 * GET /api/daily[?date=YYYY-MM-DD] → the day's questions and the player's progress. A question's
 * text (and matching items) is only included once the player has started it, since the clock
 * starts then. Future puzzles are never served.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { closeExpired, GameError, playsFor, playState } from "@/lib/game/answer";
import { gameToday, isIsoDate, withPlayer } from "@/lib/game/http";
import { FAMILY_LABELS, loadPuzzle, publicQuestions } from "@/lib/game/puzzle";

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
    const now = new Date();
    if (date === today) await closeExpired(db, playerId, puzzle, today, now);
    const plays = await playsFor(db, playerId, date);
    const started = puzzle.filter((q) => plays.has(q.idx) || date !== today);
    const pub = new Map((await publicQuestions(db, started)).map((q) => [q.idx, q]));
    const points = new Map((await db.query<{ idx: number; points: string }>(
      "SELECT idx, sum(points) AS points FROM answers WHERE player_id = $1 AND date = $2 GROUP BY idx",
      [playerId, date],
    )).rows.map((r) => [r.idx, Number(r.points)]));
    return NextResponse.json({
      date,
      isToday: date === today,
      serverNow: now.toISOString(),
      questions: puzzle.map((q) => ({
        ...(pub.get(q.idx) ?? { idx: q.idx, kind: q.kind, family: FAMILY_LABELS[q.family] ?? q.family }),
        difficulty: q.difficulty,
        play: playState(q, plays.get(q.idx), now),
        points: points.get(q.idx) ?? 0,
      })),
    });
  });
}
