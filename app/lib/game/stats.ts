/**
 * Player stats (PLAN.md §10). player_stats is a cache: it is always recomputed from `answers`
 * (computeStats is pure), both after a player finishes a day and by `npm run rebuild-stats`.
 * Final points are used where the nightly job has set them, otherwise instant points.
 */
import type { Pool, PoolClient } from "pg";

/** One question a player played (points = sum of their answers on it). */
export interface QuestionRow {
  date: string;
  idx: number;
  family: string;
  points: number;
  ended: boolean;
}

/** One recorded answer (for rarest answer / 100-point counts). */
export interface AnswerRow {
  date: string;
  points: number;
  share: number | null;
  status: string;
  entityId: string | null;
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
 * @param questions every question the player started
 * @param answers every answer of the player
 * @param questionsPerDay number of questions per date (a day counts once all have ended)
 * @param today UTC date; the current streak is 0 if the last game was before yesterday
 */
export function computeStats(
  questions: QuestionRow[], answers: AnswerRow[], questionsPerDay: Map<string, number>, today: string,
): PlayerStats {
  const byDate = new Map<string, QuestionRow[]>();
  for (const q of questions) byDate.set(q.date, [...(byDate.get(q.date) ?? []), q]);
  const finished = [...byDate.entries()]
    .filter(([d, rows]) => rows.filter((r) => r.ended).length >= (questionsPerDay.get(d) ?? 6))
    .sort(([a], [b]) => a.localeCompare(b));
  const finishedDates = new Set(finished.map(([d]) => d));

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

  const finishedAnswers = answers.filter((a) => finishedDates.has(a.date));
  let rarest: PlayerStats["rarestAnswer"] = null;
  for (const r of finishedAnswers) {
    if (r.status === "valid" && r.share !== null && r.entityId &&
        (!rarest || r.share < rarest.share)) {
      rarest = { entityId: r.entityId, share: r.share, date: r.date };
    }
  }
  const finishedRows = finished.flatMap(([, rows]) => rows);
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
    hundredPointAnswers: finishedAnswers.filter((r) => r.points === 100 && r.status === "valid").length,
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
  const questions = (await db.query<{
    date: string; idx: number; family: string; points: string; ended: boolean; per_day: string;
  }>(
    `SELECT to_char(p.date, 'YYYY-MM-DD') AS date, p.idx, q.family, p.ended_at IS NOT NULL AS ended,
            (SELECT coalesce(sum(coalesce(a.final_points, a.points)), 0) FROM answers a
             WHERE a.player_id = p.player_id AND a.date = p.date AND a.idx = p.idx) AS points,
            (SELECT count(*) FROM puzzle_questions q2 WHERE q2.date = p.date) AS per_day
     FROM question_plays p JOIN puzzle_questions q ON q.date = p.date AND q.idx = p.idx
     WHERE p.player_id = $1`,
    [playerId],
  )).rows;
  const answers = (await db.query<{
    date: string; points: number; share: number | null; status: string; matched_entity_id: string | null;
  }>(
    `SELECT to_char(date, 'YYYY-MM-DD') AS date, coalesce(final_points, points) AS points,
            coalesce(final_share, share) AS share, status, matched_entity_id
     FROM answers WHERE player_id = $1`,
    [playerId],
  )).rows;
  const perDay = new Map(questions.map((r) => [r.date, Number(r.per_day)]));
  const stats = computeStats(
    questions.map((r) => ({ date: r.date, idx: r.idx, family: r.family, points: Number(r.points), ended: r.ended })),
    answers.map((r) => ({ date: r.date, points: r.points, share: r.share, status: r.status, entityId: r.matched_entity_id })),
    perDay, today,
  );
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
    "SELECT DISTINCT player_id FROM question_plays",
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
