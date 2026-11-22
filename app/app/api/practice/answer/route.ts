/**
 * POST /api/practice/answer — same body and responses as /api/answer, with idx = the practice
 * question id (date is ignored). Nothing is stored. Rate limited per IP.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { GameError } from "@/lib/game/answer";
import { clientIp, errorResponse } from "@/lib/game/http";
import { answerPractice } from "@/lib/game/practice";
import { rateLimit } from "@/lib/game/ratelimit";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    if (!rateLimit(`practice:${clientIp(req)}`, 120, 60_000)) {
      throw new GameError("rate_limited", "Too many answers, slow down", 429);
    }
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || !Number.isInteger(body.idx)) throw new GameError("bad_idx", "Missing question number");
    if (body.text !== undefined && typeof body.text !== "string") throw new GameError("bad_text", "text must be a string");
    const confirm = typeof body.confirm_entity_id === "string" ? body.confirm_entity_id : undefined;
    return NextResponse.json(await answerPractice(getPool(), {
      idx: body.idx as number, text: body.text as string | undefined, confirmEntityId: confirm,
      pairs: body.pairs as number[] | undefined, order: body.order as number[] | undefined,
    }));
  } catch (e) {
    return errorResponse(e);
  }
}
