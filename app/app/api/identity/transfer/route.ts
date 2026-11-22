/** POST /api/identity/transfer → { code, expiresAt }: a one-time code to play on another device. */
import { NextResponse, type NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { withPlayer } from "@/lib/game/http";
import { createTransferCode } from "@/lib/game/transfer";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  return withPlayer(req, async (playerId) => NextResponse.json(await createTransferCode(getPool(), playerId)));
}
