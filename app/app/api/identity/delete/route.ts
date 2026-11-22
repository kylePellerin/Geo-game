/** POST /api/identity/delete → deletes this player's data and forgets the cookie. */
import { NextResponse, type NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { errorResponse } from "@/lib/game/http";
import { isUuid, PLAYER_COOKIE } from "@/lib/game/identity";
import { deletePlayer } from "@/lib/game/transfer";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const cookie = req.cookies.get(PLAYER_COOKIE)?.value;
    if (isUuid(cookie)) await deletePlayer(getPool(), cookie);
    const res = NextResponse.json({ deleted: true });
    res.cookies.delete(PLAYER_COOKIE);
    return res;
  } catch (e) {
    return errorResponse(e);
  }
}
