/** Pure helpers for the game screen (no React, no fetch) so they can be unit tested. */
import { TIER_EMOJI, TIERS, type Tier } from "../game/scoring";
import type { Progress, Question } from "./types";

export const TIER_LABEL: Record<Tier, string> = Object.fromEntries(
  TIERS.map((t) => [t.tier, t.label]),
) as Record<Tier, string>;

/** The question to show on load: the first unanswered one, or null if the day is done. */
export function firstUnanswered(questions: Question[], answered: Set<number>): number | null {
  return questions.find((q) => !answered.has(q.idx))?.idx ?? null;
}

/** The next unanswered question after `idx` (wrapping round), or null if none are left. */
export function nextUnanswered(questions: Question[], answered: Set<number>, idx: number): number | null {
  const at = questions.findIndex((q) => q.idx === idx);
  for (let i = 1; i <= questions.length; i++) {
    const q = questions[(at + i) % questions.length];
    if (!answered.has(q.idx)) return q.idx;
  }
  return null;
}

/** One emoji per question for the progress strip (same symbols as the share text). */
export function progressEmoji(p: Progress | undefined, q: Question): string {
  if (!p) return "▫️";
  if (q.kind === "match") return "🧩";
  return p.tier ? TIER_EMOJI[p.tier] : TIER_EMOJI.wrong;
}

/**
 * Matching rounds: assign right item `right` to left item `left`. A right item can only be
 * used once, so whoever had it before loses it. `right = null` clears the row.
 */
export function assignPair(pairs: (number | null)[], left: number, right: number | null): (number | null)[] {
  return pairs.map((r, i) => {
    if (i === left) return right;
    return right !== null && r === right ? null : r;
  });
}

export const pairsComplete = (pairs: (number | null)[]): pairs is number[] =>
  pairs.length > 0 && pairs.every((p) => p !== null);

/** "12%" / "<1%" for shares in 0..1. */
export function formatShare(share: number): string {
  const pct = share * 100;
  if (pct > 0 && pct < 1) return "<1%";
  return `${Math.round(pct)}%`;
}

/** Time until the next puzzle (00:00 UTC) as "5h 03m". */
export function untilNextPuzzle(now: Date): string {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  const mins = Math.max(0, Math.ceil((next - now.getTime()) / 60_000));
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
}

const ARTICLE = /^[aeiou]/i;
/** "a city" / "an airport" for the wrong-type hint. */
export function withArticle(type: string): string {
  const word = type.replace(/_/g, " ");
  return `${ARTICLE.test(word) ? "an" : "a"} ${word}`;
}
