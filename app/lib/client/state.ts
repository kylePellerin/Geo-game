/** Pure helpers for the game screen (no React, no fetch) so they can be unit tested. */
import { TIERS, type Tier } from "../game/scoring";
import type { DayQuestion } from "./types";

export const TIER_LABEL: Record<Tier, string> = Object.fromEntries(
  TIERS.map((t) => [t.tier, t.label]),
) as Record<Tier, string>;

/** The question the player is on: the first that isn't done, or null when the day is over. */
export function currentQuestion(questions: DayQuestion[]): number | null {
  return questions.find((q) => q.play.state !== "done")?.idx ?? null;
}

/** Label for a question in the progress strip. */
export function stripLabel(q: DayQuestion, n: number): string {
  if (q.play.state === "done") return `${n} · ${q.points}`;
  if (q.play.state === "playing") return `${n} ⏱`;
  return `${n}`;
}

/** Milliseconds left before `deadline`, given the server clock offset (server - client). */
export function remainingMs(deadline: string, offsetMs: number, nowMs: number): number {
  return Math.max(0, Date.parse(deadline) - (nowMs + offsetMs));
}

/** Ordering rounds: move the item at `from` to `to`. */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length || from === to) return list;
  const out = [...list];
  const [it] = out.splice(from, 1);
  out.splice(to, 0, it);
  return out;
}

/** "1,234,567 people", "2012", "8,611 m". */
export function formatValue(value: number, unit: string): string {
  if (unit === "year") return String(Math.round(value));
  return `${Math.round(value).toLocaleString("en-US")}${unit ? ` ${unit}` : ""}`;
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
