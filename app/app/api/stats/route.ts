/** GET /api/stats → the player's stats (PLAN.md §10); the stats page itself comes in Phase 7. */
import { NextResponse, type NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { withPlayer } from "@/lib/game/http";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return withPlayer(req, async (playerId) => {
    const { rows } = await getPool().query(
      `SELECT s.*, e.name AS rarest_answer_name FROM player_stats s
       LEFT JOIN entities e ON e.id = s.rarest_answer_entity_id WHERE s.player_id = $1`,
      [playerId],
    );
    return NextResponse.json({ playerId, stats: rows[0] ?? null });
  });
}
