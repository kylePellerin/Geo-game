/**
 * POST /api/answer
 *   free text: { date, idx, text, confirm_entity_id? }
 *   matching:  { date, idx, pairs: [rightPos for each leftPos, -1 = unpaired] }
 *   ordering:  { date, idx, order: [display positions in the player's order] }
 *   (the question must be started and its time not up; see lib/game/answer.ts)
 * → free text: { status: valid | real_but_wrong | unrecognised | did_you_mean | duplicate, entity,
 *   suggestion, points, tier, share, questionPoints }; matching: the question summary.
 * Rate limited per player and per IP.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { GameError, submitAnswer } from "@/lib/game/answer";
import { clientIp, gameToday, isIsoDate, withPlayer } from "@/lib/game/http";
import { rateLimit } from "@/lib/game/ratelimit";

export const dynamic = "force-dynamic";

const PER_PLAYER = { limit: 90, windowMs: 60_000 }; // several answers per question now
const PER_IP = { limit: 120, windowMs: 60_000 };

export async function POST(req: NextRequest) {
  return withPlayer(req, async (playerId) => {
    if (!rateLimit(`p:${playerId}`, PER_PLAYER.limit, PER_PLAYER.windowMs) ||
        !rateLimit(`ip:${clientIp(req)}`, PER_IP.limit, PER_IP.windowMs)) {
      throw new GameError("rate_limited", "Too many answers, slow down", 429);
    }
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") throw new GameError("bad_body", "Send JSON");
    const { date, idx, text, confirm_entity_id: confirm, pairs, order } = body as Record<string, unknown>;
    if (typeof date !== "string" || !isIsoDate(date)) throw new GameError("bad_date", "Missing date");
    if (!Number.isInteger(idx)) throw new GameError("bad_idx", "Missing question number");
    if (text !== undefined && typeof text !== "string") throw new GameError("bad_text", "text must be a string");
    if (confirm !== undefined && typeof confirm !== "string") throw new GameError("bad_confirm", "Bad confirm id");
    return NextResponse.json(await submitAnswer(getPool(), {
      playerId, date, idx: idx as number, text: text as string | undefined,
      confirmEntityId: confirm as string | undefined, pairs: pairs as number[] | undefined, order: order as number[] | undefined,
      today: gameToday(),
    }));
  });
}
