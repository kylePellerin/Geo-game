/**
 * POST /api/identity/reconcile { local_id } → { player_id }
 * Called when the cookie and the localStorage copy disagree or one is missing (PLAN.md §10).
 * Keeps the id that has history and sets the cookie to it.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { errorResponse } from "@/lib/game/http";
import { cookieOptions, PLAYER_COOKIE, reconcile } from "@/lib/game/identity";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { local_id?: unknown };
    const id = await reconcile(getPool(), req.cookies.get(PLAYER_COOKIE)?.value, body.local_id);
    const res = NextResponse.json({ player_id: id });
    res.cookies.set(PLAYER_COOKIE, id, cookieOptions);
    return res;
  } catch (e) {
    return errorResponse(e);
  }
}
