/** A player's results for a date and the share text (PLAN.md §7 GET /api/results/:date). */
import type { Pool } from "pg";
import { closeExpired, playsFor, playState } from "./answer";
import { FAMILY_LABELS, loadPuzzle } from "./puzzle";
import { TIER_EMOJI, TIERS, type Tier } from "./scoring";
import { dailyPercentile } from "./stats";

export interface QuestionResult {
  idx: number;
  /** only once the question has been started */
  text?: string;
  family: string;
  kind: "free_text" | "match" | "order";
  state: "not_started" | "playing" | "done";
  points: number;
  finalPoints?: number;
  answers: { name: string; status: string; points: number; tier?: Tier; share?: number }[];
  correctPairs?: number;
  pairCount?: number;
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

const TIER_RANK = new Map(TIERS.map((t, i) => [t.tier, i]));

export function shareEmoji(q: QuestionResult): string {
  if (q.state !== "done") return "▫️";
  if (q.pairCount !== undefined) return `${q.kind === "order" ? "🔢" : "🧩"}${q.correctPairs ?? 0}/${q.pairCount}`;
  const valid = q.answers.filter((a) => a.status === "valid" && a.tier);
  if (!valid.length) return TIER_EMOJI.wrong;
  // the rarest tier reached, plus how many right answers when more than one
  const best = valid.reduce((b, a) => (TIER_RANK.get(a.tier!)! > TIER_RANK.get(b.tier!)! ? a : b));
  return `${TIER_EMOJI[best.tier!]}${valid.length > 1 ? valid.length : ""}`;
}

export async function getResults(db: Pool, playerId: string, date: string, today: string): Promise<DayResults | null> {
  const puzzle = await loadPuzzle(db, date);
  if (!puzzle) return null;
  const now = new Date();
  if (date === today) await closeExpired(db, playerId, puzzle, today, now);
  const plays = await playsFor(db, playerId, date);
  const { rows } = await db.query<{
    idx: number; status: string; points: number; final_points: number | null; tier: Tier | null;
    share: number | null; name: string | null; kind: string; detail: { correct?: boolean[] };
  }>(
    `SELECT a.idx, a.status, a.points, a.final_points, a.tier, a.share, e.name, a.kind, a.detail
     FROM answers a LEFT JOIN entities e ON e.id = a.matched_entity_id
     WHERE a.player_id = $1 AND a.date = $2 ORDER BY a.id`,
    [playerId, date],
  );
  const questions = puzzle.map((q): QuestionResult => {
    const state = playState(q, plays.get(q.idx), now).state;
    const mine = rows.filter((r) => r.idx === q.idx);
    const finals = mine.map((r) => r.final_points);
    const base: QuestionResult = {
      idx: q.idx, kind: q.kind, family: FAMILY_LABELS[q.family] ?? q.family, state,
      ...(state !== "not_started" ? { text: q.text } : {}),
      points: mine.reduce((s, r) => s + r.points, 0),
      ...(state === "done" && finals.every((f) => f !== null)
        ? { finalPoints: finals.reduce((s: number, f) => s + (f ?? 0), 0) } : {}),
      answers: mine.filter((r) => r.kind === "free_text").map((r) => ({
        name: r.name ?? "?", status: r.status, points: r.points,
        ...(r.tier ? { tier: r.tier } : {}), ...(r.share !== null ? { share: r.share } : {}),
      })),
    };
    if (q.kind !== "free_text") {
      base.pairCount = q.kind === "match" ? q.pairs.length : q.items.length;
      base.correctPairs = (mine[0]?.detail.correct ?? []).filter(Boolean).length;
    }
    return base;
  });
  const total = questions.reduce((s, q) => s + q.points, 0);
  const finished = questions.every((q) => q.state === "done");
  const finalTotal = finished && questions.every((q) => q.finalPoints !== undefined)
    ? questions.reduce((s, q) => s + (q.finalPoints ?? 0), 0) : null;
  return {
    date, questions, total, finalTotal, finished,
    percentile: finished ? await dailyPercentile(db, date, playerId) : null,
    shareText: `Geo-rarity ${date} · ${total} pts\n${questions.map(shareEmoji).join(" ")}`,
  };
}
