/** POST /api/question/start { date, idx } → the question, its clock, and any answers so far. */
import { NextResponse, type NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { GameError, startQuestion } from "@/lib/game/answer";
import { gameToday, isIsoDate, withPlayer } from "@/lib/game/http";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  return withPlayer(req, async (playerId) => {
    const body = (await req.json().catch(() => null)) as { date?: unknown; idx?: unknown } | null;
    if (typeof body?.date !== "string" || !isIsoDate(body.date)) throw new GameError("bad_date", "Missing date");
    if (!Number.isInteger(body.idx)) throw new GameError("bad_idx", "Missing question number");
    return NextResponse.json(await startQuestion(getPool(), {
      playerId, date: body.date, idx: body.idx as number, today: gameToday(),
    }));
  });
}
