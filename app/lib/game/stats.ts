/**
 * Player stats (PLAN.md §10). player_stats is a cache: it is always recomputed from `answers`
 * (computeStats is pure), both after a player finishes a day and by `npm run rebuild-stats`.
 * Final points are used where the nightly job has set them, otherwise instant points.
 */
import type { Pool, PoolClient } from "pg";

export interface AnswerRow {
  date: string;
  idx: number;
  points: number;
  share: number | null;
  status: string;
  entityId: string | null;
  family: string;
}

export interface PlayerStats {
  gamesPlayed: number;
  currentStreak: number;
  maxStreak: number;
  lastPlayedDate: string | null;
  bestScore: number | null;
  bestScoreDate: string | null;
  totalPoints: number;
  hundredPointAnswers: number;
  rarestAnswer: { entityId: string; share: number; date: string } | null;
  scoreHistogram: Record<string, number>;
  familyStats: Record<string, { n: number; avg: number }>;
}

const DAY_MS = 86_400_000;
const dayNum = (d: string) => Math.round(Date.parse(`${d}T00:00:00Z`) / DAY_MS);

export function histogramBucket(score: number): string {
  const lo = Math.floor(score / 100) * 100;
  return `${lo}-${lo + 99}`;
}

/**
 * @param answers every answer of the player
 * @param questionsPerDay number of questions per date (a day counts once all are answered)
 * @param today UTC date; the current streak is 0 if the last game was before yesterday
 */
export function computeStats(
  answers: AnswerRow[], questionsPerDay: Map<string, number>, today: string,
): PlayerStats {
  const byDate = new Map<string, AnswerRow[]>();
  for (const a of answers) byDate.set(a.date, [...(byDate.get(a.date) ?? []), a]);
  const finished = [...byDate.entries()]
    .filter(([d, rows]) => rows.length >= (questionsPerDay.get(d) ?? 6))
    .sort(([a], [b]) => a.localeCompare(b));

  let maxStreak = 0;
  let run = 0;
  let prev: number | null = null;
  let best: { score: number; date: string } | null = null;
  const histogram: Record<string, number> = {};
  let total = 0;
  for (const [date, rows] of finished) {
    const n = dayNum(date);
    run = prev !== null && n === prev + 1 ? run + 1 : 1;
    maxStreak = Math.max(maxStreak, run);
    prev = n;
    const score = rows.reduce((s, r) => s + r.points, 0);
    total += score;
    histogram[histogramBucket(score)] = (histogram[histogramBucket(score)] ?? 0) + 1;
    if (!best || score > best.score) best = { score, date };
  }
  const last = finished.at(-1)?.[0] ?? null;
  const currentStreak = last !== null && dayNum(today) - dayNum(last) <= 1 ? run : 0;

  const finishedRows = finished.flatMap(([, rows]) => rows);
  let rarest: PlayerStats["rarestAnswer"] = null;
  for (const r of finishedRows) {
    if (r.status === "valid" && r.share !== null && r.entityId &&
        (!rarest || r.share < rarest.share)) {
      rarest = { entityId: r.entityId, share: r.share, date: r.date };
    }
  }
  const fam: Record<string, { n: number; sum: number }> = {};
  for (const r of finishedRows) {
    fam[r.family] ??= { n: 0, sum: 0 };
    fam[r.family].n += 1;
    fam[r.family].sum += r.points;
  }
  return {
    gamesPlayed: finished.length,
    currentStreak,
    maxStreak,
    lastPlayedDate: last,
    bestScore: best?.score ?? null,
    bestScoreDate: best?.date ?? null,
    totalPoints: total,
    hundredPointAnswers: finishedRows.filter((r) => r.points === 100 && r.status === "valid").length,
    rarestAnswer: rarest,
    scoreHistogram: histogram,
    familyStats: Object.fromEntries(Object.entries(fam).map(([k, v]) => [k, {
      n: v.n, avg: Math.round((v.sum / v.n) * 10) / 10,
    }])),
  };
}

/** Recompute and store one player's stats from their answers. */
export async function refreshPlayerStats(
  db: Pool | PoolClient, playerId: string, today: string,
): Promise<PlayerStats> {
  const { rows } = await db.query<{
    date: string; idx: number; points: number; share: number | null; status: string;
    matched_entity_id: string | null; family: string; per_day: string;
  }>(
    `SELECT to_char(a.date, 'YYYY-MM-DD') AS date, a.idx, coalesce(a.final_points, a.points) AS points,
            coalesce(a.final_share, a.share) AS share, a.status, a.matched_entity_id, q.family,
            (SELECT count(*) FROM puzzle_questions q2 WHERE q2.date = a.date) AS per_day
     FROM answers a JOIN puzzle_questions q ON q.date = a.date AND q.idx = a.idx
     WHERE a.player_id = $1`,
    [playerId],
  );
  const perDay = new Map(rows.map((r) => [r.date, Number(r.per_day)]));
  const stats = computeStats(rows.map((r) => ({
    date: r.date, idx: r.idx, points: r.points, share: r.share, status: r.status,
    entityId: r.matched_entity_id, family: r.family,
  })), perDay, today);
  await db.query(
    `INSERT INTO player_stats (player_id, games_played, current_streak, max_streak,
       last_played_date, best_score, best_score_date, total_points, hundred_point_answers,
       rarest_answer_entity_id, rarest_answer_share, rarest_answer_date, score_histogram,
       family_stats, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now())
     ON CONFLICT (player_id) DO UPDATE SET games_played = $2, current_streak = $3,
       max_streak = $4, last_played_date = $5, best_score = $6, best_score_date = $7,
       total_points = $8, hundred_point_answers = $9, rarest_answer_entity_id = $10,
       rarest_answer_share = $11, rarest_answer_date = $12, score_histogram = $13,
       family_stats = $14, updated_at = now()`,
    [playerId, stats.gamesPlayed, stats.currentStreak, stats.maxStreak, stats.lastPlayedDate,
     stats.bestScore, stats.bestScoreDate, stats.totalPoints, stats.hundredPointAnswers,
     stats.rarestAnswer?.entityId ?? null, stats.rarestAnswer?.share ?? null,
     stats.rarestAnswer?.date ?? null, JSON.stringify(stats.scoreHistogram),
     JSON.stringify(stats.familyStats)],
  );
  return stats;
}

/** Rebuild every player's stats from answers (PLAN §10: player_stats is only a cache). */
export async function rebuildAllPlayerStats(db: Pool, today: string): Promise<number> {
  const { rows } = await db.query<{ player_id: string }>(
    "SELECT DISTINCT player_id FROM answers",
  );
  for (const r of rows) await refreshPlayerStats(db, r.player_id, today);
  return rows.length;
}

/** "Better than X% of players today": share of finished players with a lower score. */
export async function dailyPercentile(db: Pool, date: string, playerId: string): Promise<number | null> {
  const { rows } = await db.query<{ pct: number | null }>(
    `WITH s AS (SELECT player_id, coalesce(final_points, instant_points) AS pts
                FROM daily_scores WHERE date = $1 AND finished)
     SELECT CASE WHEN count(*) <= 1 THEN NULL ELSE
       100.0 * count(*) FILTER (WHERE pts < (SELECT pts FROM s WHERE player_id = $2))
             / (count(*) - 1) END AS pct
     FROM s`,
    [date, playerId],
  );
  return rows[0]?.pct === null || rows[0]?.pct === undefined ? null : Math.round(Number(rows[0].pct));
}
