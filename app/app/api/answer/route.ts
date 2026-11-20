/**
 * POST /api/answer
 *   free text: { date, idx, text, confirm_entity_id? }
 *   matching:  { date, idx, pairs: [rightPos for each leftPos] }
 * → status valid | real_but_wrong | unrecognised | did_you_mean | match, points, tier, share,
 *   common_answers, rare_answers (see lib/game/answer.ts). Rate limited per player and per IP.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { GameError, submitAnswer } from "@/lib/game/answer";
import { clientIp, gameToday, isIsoDate, withPlayer } from "@/lib/game/http";
import { rateLimit } from "@/lib/game/ratelimit";

export const dynamic = "force-dynamic";

const PER_PLAYER = { limit: 30, windowMs: 60_000 };
const PER_IP = { limit: 120, windowMs: 60_000 };

export async function POST(req: NextRequest) {
  return withPlayer(req, async (playerId) => {
    if (!rateLimit(`p:${playerId}`, PER_PLAYER.limit, PER_PLAYER.windowMs) ||
        !rateLimit(`ip:${clientIp(req)}`, PER_IP.limit, PER_IP.windowMs)) {
      throw new GameError("rate_limited", "Too many answers, slow down", 429);
    }
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") throw new GameError("bad_body", "Send JSON");
    const { date, idx, text, confirm_entity_id: confirm, pairs } = body as Record<string, unknown>;
    if (typeof date !== "string" || !isIsoDate(date)) throw new GameError("bad_date", "Missing date");
    if (!Number.isInteger(idx)) throw new GameError("bad_idx", "Missing question number");
    if (text !== undefined && typeof text !== "string") throw new GameError("bad_text", "text must be a string");
    if (confirm !== undefined && typeof confirm !== "string") throw new GameError("bad_confirm", "Bad confirm id");
    const result = await submitAnswer(getPool(), {
      playerId, date, idx: idx as number, text: text as string | undefined,
      confirmEntityId: confirm as string | undefined, pairs: pairs as number[] | undefined,
      today: gameToday(),
    });
    return NextResponse.json({
      status: result.status,
      final: result.final,
      already_answered: result.alreadyAnswered ?? false,
      entity: result.entity,
      suggestion: result.suggestion,
      alternative: result.alternative,
      other_type: result.otherType,
      attempts_left: result.attemptsLeft,
      points: result.points,
      tier: result.tier,
      share: result.share,
      common_answers: result.commonAnswers,
      rare_answers: result.rareAnswers,
      correct: result.correct,
      solution: result.solution,
      day_complete: result.dayComplete,
    });
  });
}
