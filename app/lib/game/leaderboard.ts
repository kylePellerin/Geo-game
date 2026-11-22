/**
 * Daily leaderboard (PLAN.md phase 7): players who finished the day, by points (final points
 * once the nightly job has run, instant points until then). Ties share a rank.
 */
import type { Pool } from "pg";
import { displayName } from "./names";

export const LEADERBOARD_SIZE = 20;

export interface LeaderRow { rank: number; name: string; points: number; you: boolean }
export interface Leaderboard {
  date: string;
  /** players who finished the day */
  players: number;
  final: boolean;
  top: LeaderRow[];
  /** the asking player's own row, if they finished (also when outside the top) */
  you: LeaderRow | null;
}

export async function leaderboard(db: Pool, date: string, playerId: string | null): Promise<Leaderboard> {
  const { rows } = await db.query<{
    player_id: string; pts: number; rnk: string; n: string; is_final: boolean;
  }>(
    `WITH s AS (
       SELECT player_id, coalesce(final_points, instant_points) AS pts, final_points IS NOT NULL AS is_final
       FROM daily_scores WHERE date = $1 AND finished),
     r AS (SELECT *, rank() OVER (ORDER BY pts DESC) AS rnk, count(*) OVER () AS n FROM s)
     SELECT * FROM r WHERE rnk <= $2 OR player_id = $3
     ORDER BY rnk, player_id`,
    [date, LEADERBOARD_SIZE, playerId],
  );
  const toRow = (r: (typeof rows)[number]): LeaderRow => ({
    rank: Number(r.rnk), name: displayName(r.player_id), points: r.pts, you: r.player_id === playerId,
  });
  const top = rows.filter((r) => Number(r.rnk) <= LEADERBOARD_SIZE).slice(0, LEADERBOARD_SIZE).map(toRow);
  const mine = rows.find((r) => r.player_id === playerId);
  return {
    date,
    players: rows.length ? Number(rows[0].n) : 0,
    final: rows.length > 0 && rows.every((r) => r.is_final),
    top,
    you: mine ? toRow(mine) : null,
  };
}
