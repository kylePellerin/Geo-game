/** Shared helpers for the API route handlers. */
import { NextResponse, type NextRequest } from "next/server";
import { getPool } from "../db";
import { GameError } from "./answer";
import { cookieOptions, ensurePlayer, PLAYER_COOKIE } from "./identity";
import { utcToday } from "./puzzle";

/** Today's UTC date. GAME_TODAY overrides it outside production (manual testing). */
export function gameToday(): string {
  if (process.env.GAME_TODAY && process.env.NODE_ENV !== "production") return process.env.GAME_TODAY;
  return utcToday();
}

export const isIsoDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

export function errorResponse(e: unknown): NextResponse {
  if (e instanceof GameError) {
    return NextResponse.json({ error: e.code, message: e.message }, { status: e.httpStatus });
  }
  console.error(e);
  return NextResponse.json({ error: "internal", message: "Something went wrong" }, { status: 500 });
}

/** Run a handler with the player's id, creating the player and cookie on first visit. */
export async function withPlayer(
  req: NextRequest,
  handler: (playerId: string) => Promise<NextResponse>,
): Promise<NextResponse> {
  try {
    const cookie = req.cookies.get(PLAYER_COOKIE)?.value;
    const player = await ensurePlayer(getPool(), cookie);
    const res = await handler(player.id);
    if (cookie !== player.id) res.cookies.set(PLAYER_COOKIE, player.id, cookieOptions);
    return res;
  } catch (e) {
    return errorResponse(e);
  }
}

export function clientIp(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("x-real-ip") || "local";
}
