/**
 * GET /api/stats → the player's stats for the stats page (PLAN.md §10), read from the
 * player_stats cache. The current streak is 0 once a day has been missed, even if the cache was
 * written before that.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { gameToday, withPlayer } from "@/lib/game/http";
import { displayName } from "@/lib/game/names";
import { FAMILY_LABELS } from "@/lib/game/puzzle";
import { dailyPercentile } from "@/lib/game/stats";

export const dynamic = "force-dynamic";

const DAY_MS = 86_400_000;

/** Every 100-point bucket from 0 up to at least 500, empty ones included, so one day isn't one huge bar. */
function histogram(h: Record<string, number>): { from: number; n: number }[] {
  const counts = new Map(Object.entries(h).map(([k, n]) => [Number(k.split("-")[0]), n]));
  const top = Math.max(500, ...counts.keys());
  const out = [];
  for (let from = 0; from <= top; from += 100) out.push({ from, n: counts.get(from) ?? 0 });
  return out;
}

export async function GET(req: NextRequest) {
  return withPlayer(req, async (playerId) => {
    const db = getPool();
    const today = gameToday();
    const { rows } = await db.query<{
      games_played: number; current_streak: number; max_streak: number; last_played_date: string | null;
      best_score: number | null; best_score_date: string | null; total_points: string;
      hundred_point_answers: number; rarest_answer_name: string | null; rarest_answer_share: number | null;
      rarest_answer_date: string | null; score_histogram: Record<string, number>;
      family_stats: Record<string, { n: number; avg: number }>;
    }>(
      `SELECT s.games_played, s.current_streak, s.max_streak,
              to_char(s.last_played_date, 'YYYY-MM-DD') AS last_played_date,
              s.best_score, to_char(s.best_score_date, 'YYYY-MM-DD') AS best_score_date,
              s.total_points, s.hundred_point_answers, e.name AS rarest_answer_name,
              s.rarest_answer_share, to_char(s.rarest_answer_date, 'YYYY-MM-DD') AS rarest_answer_date,
              s.score_histogram, s.family_stats
       FROM player_stats s LEFT JOIN entities e ON e.id = s.rarest_answer_entity_id
       WHERE s.player_id = $1`,
      [playerId],
    );
    const s = rows[0];
    const name = displayName(playerId);
    if (!s || s.games_played === 0) return NextResponse.json({ name, stats: null });
    const missed = s.last_played_date !== null &&
      (Date.parse(today) - Date.parse(s.last_played_date)) / DAY_MS > 1;
    const families = Object.entries(s.family_stats)
      .filter(([, v]) => v.n >= 2)
      .map(([k, v]) => ({ family: FAMILY_LABELS[k] ?? k, n: v.n, avg: v.avg }))
      .sort((a, b) => b.avg - a.avg);
    return NextResponse.json({
      name,
      stats: {
        gamesPlayed: s.games_played,
        currentStreak: missed ? 0 : s.current_streak,
        maxStreak: s.max_streak,
        bestScore: s.best_score, bestScoreDate: s.best_score_date,
        average: Math.round(Number(s.total_points) / s.games_played),
        hundredPointAnswers: s.hundred_point_answers,
        rarestAnswer: s.rarest_answer_name && s.rarest_answer_share !== null
          ? { name: s.rarest_answer_name, share: s.rarest_answer_share, date: s.rarest_answer_date } : null,
        histogram: histogram(s.score_histogram),
        bestFamily: families[0] ?? null,
        worstFamily: families.length > 1 ? families[families.length - 1] : null,
        todayPercentile: s.last_played_date === today ? await dailyPercentile(db, today, playerId) : null,
      },
    });
  });
}
