/** POST /api/practice/reveal { idx } → the summary of a practice question (time up or skipped). */
import { NextResponse, type NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { GameError } from "@/lib/game/answer";
import { errorResponse } from "@/lib/game/http";
import { revealPractice } from "@/lib/game/practice";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as { idx?: unknown } | null;
    if (!body || !Number.isInteger(body.idx)) throw new GameError("bad_idx", "Missing question number");
    return NextResponse.json(await revealPractice(getPool(), body.idx as number));
  } catch (e) {
    return errorResponse(e);
  }
}
