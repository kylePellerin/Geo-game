/** A player's results for a date and the share text (PLAN.md §7 GET /api/results/:date). */
import type { Pool } from "pg";
import { loadPuzzle } from "./puzzle";
import { TIER_EMOJI, type Tier } from "./scoring";
import { dailyPercentile } from "./stats";

export interface QuestionResult {
  idx: number;
  text: string;
  family: string;
  answered: boolean;
  status?: string;
  answer?: string;
  points: number;
  finalPoints?: number;
  tier?: Tier;
  share?: number;
  correctPairs?: number;
}

export interface DayResults {
  date: string;
  questions: QuestionResult[];
  total: number;
  finalTotal: number | null;
  finished: boolean;
  percentile: number | null;
  shareText: string;
}

export async function getResults(db: Pool, playerId: string, date: string): Promise<DayResults | null> {
  const puzzle = await loadPuzzle(db, date);
  if (!puzzle) return null;
  const { rows } = await db.query<{
    idx: number; status: string; points: number; final_points: number | null; tier: Tier | null;
    share: number | null; name: string | null; detail: { correct?: boolean[] };
  }>(
    `SELECT a.idx, a.status, a.points, a.final_points, a.tier, a.share, e.name, a.detail
     FROM answers a LEFT JOIN entities e ON e.id = a.matched_entity_id
     WHERE a.player_id = $1 AND a.date = $2`,
    [playerId, date],
  );
  const byIdx = new Map(rows.map((r) => [r.idx, r]));
  const questions = puzzle.map((q): QuestionResult => {
    const r = byIdx.get(q.idx);
    if (!r) return { idx: q.idx, text: q.text, family: q.family, answered: false, points: 0 };
    return {
      idx: q.idx, text: q.text, family: q.family, answered: true, status: r.status,
      ...(r.name ? { answer: r.name } : {}), points: r.points,
      ...(r.final_points !== null ? { finalPoints: r.final_points } : {}),
      ...(r.tier ? { tier: r.tier } : {}), ...(r.share !== null ? { share: r.share } : {}),
      ...(q.kind === "match" ? { correctPairs: (r.detail.correct ?? []).filter(Boolean).length } : {}),
    };
  });
  const total = questions.reduce((s, q) => s + q.points, 0);
  const finished = questions.every((q) => q.answered);
  const finals = questions.map((q) => q.finalPoints);
  const finalTotal = finished && finals.every((f) => f !== undefined)
    ? finals.reduce((s: number, f) => s + (f ?? 0), 0) : null;
  const emoji = questions.map((q) => {
    if (!q.answered) return "▫️";
    if (q.correctPairs !== undefined) return `🧩${q.correctPairs}/4`;
    return q.tier ? TIER_EMOJI[q.tier] : TIER_EMOJI.wrong;
  });
  return {
    date, questions, total, finalTotal, finished,
    percentile: finished ? await dailyPercentile(db, date, playerId) : null,
    shareText: `Geo-rarity ${date} · ${total} pts\n${emoji.join(" ")}`,
  };
}
