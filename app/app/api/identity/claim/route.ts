/**
 * POST /api/identity/claim { code } → { player_id, merged_days }
 * This device becomes the player who made the code; its own history (if any) is merged in.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { clientIp, errorResponse, gameToday } from "@/lib/game/http";
import { cookieOptions, isUuid, PLAYER_COOKIE } from "@/lib/game/identity";
import { claimTransferCode } from "@/lib/game/transfer";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { code?: unknown };
    const cookie = req.cookies.get(PLAYER_COOKIE)?.value;
    const r = await claimTransferCode(getPool(), body.code, isUuid(cookie) ? cookie : null,
                                      clientIp(req), gameToday());
    const res = NextResponse.json({ player_id: r.playerId, merged_days: r.mergedDays });
    res.cookies.set(PLAYER_COOKIE, r.playerId, cookieOptions);
    return res;
  } catch (e) {
    return errorResponse(e);
  }
}
