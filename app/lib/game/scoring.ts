/**
 * Scoring (PLAN.md §1 and §6). Pure functions, no database.
 *
 * Free-text answers: est_share = w * observed + (1 - w) * prior, w = n_total / (n_total + 50).
 *   observed = players giving this answer / players answering the question (wrong ones included)
 *   prior    = softmax(popularity / T) over the valid set, T solved per question so the most
 *              popular answer gets PRIOR_TOP_SHARE (cold start: before many people have played)
 * The estimated share maps to one of five tiers. Matching rounds score per correct pair by the
 * item's rarity category.
 */

export type Tier = "famous" | "well_known" | "familiar" | "obscure" | "rarest";

/** share lower bound (exclusive) → tier, most common first. Table in PLAN.md §1. */
export const TIERS: { tier: Tier; above: number; points: number; label: string }[] = [
  { tier: "famous", above: 0.2, points: 10, label: "Famous" },
  { tier: "well_known", above: 0.1, points: 25, label: "Well known" },
  { tier: "familiar", above: 0.05, points: 50, label: "Familiar" },
  { tier: "obscure", above: 0.02, points: 75, label: "Obscure" },
  { tier: "rarest", above: -1, points: 100, label: "Rarest" },
];

export const MATCH_PAIR_POINTS: Record<Tier, number> = {
  // 4 pairs (again since 2026-11-23): a standard round (well known + 2 familiar + obscure) is ~100
  famous: 10, well_known: 15, familiar: 25, obscure: 35, rarest: 40,
};

/** Ordering rounds: points per item in the right position (5 items → 100). */
export const ORDER_POINTS_PER_ITEM = 20;

export const BLEND_K = 50;
export const PRIOR_TOP_SHARE = 0.3;

export function tierFor(share: number): { tier: Tier; points: number } {
  const t = TIERS.find((x) => share > x.above) ?? TIERS[TIERS.length - 1];
  return { tier: t.tier, points: t.points };
}

function softmax(values: number[], temperature: number): number[] {
  const max = Math.max(...values);
  const exps = values.map((v) => Math.exp((v - max) / temperature));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

/**
 * Prior share per valid entity from popularity. T is found by bisection so the top answer gets
 * `topShare` (if that's impossible because the set is tiny or flat, the closest T is used).
 */
export function priorShares(
  popularity: Map<string, number>,
  topShare = PRIOR_TOP_SHARE,
): Map<string, number> {
  const ids = [...popularity.keys()];
  if (ids.length === 0) return new Map();
  const pops = ids.map((id) => popularity.get(id) ?? 0);
  if (ids.length === 1 || Math.max(...pops) === Math.min(...pops) || 1 / ids.length >= topShare) {
    return new Map(ids.map((id) => [id, 1 / ids.length]));
  }
  // top share falls as T grows: find T with top share == topShare
  let lo = 1e-3;
  let hi = 100;
  for (let i = 0; i < 60; i++) {
    const mid = Math.sqrt(lo * hi);
    const top = Math.max(...softmax(pops, mid));
    if (top > topShare) lo = mid;
    else hi = mid;
  }
  const shares = softmax(pops, Math.sqrt(lo * hi));
  return new Map(ids.map((id, i) => [id, shares[i]]));
}

export function blendWeight(nTotal: number): number {
  return nTotal / (nTotal + BLEND_K);
}

export function estimatedShare(nSame: number, nTotal: number, prior: number): number {
  const observed = nTotal > 0 ? nSame / nTotal : 0;
  const w = blendWeight(nTotal);
  return w * observed + (1 - w) * prior;
}

export function scoreAnswer(nSame: number, nTotal: number, prior: number) {
  const share = estimatedShare(nSame, nTotal, prior);
  return { share, ...tierFor(share) };
}

export function matchPoints(correct: { category: Tier }[]): number {
  return correct.reduce((sum, c) => sum + MATCH_PAIR_POINTS[c.category], 0);
}

/** Emoji for the share text. */
export const TIER_EMOJI: Record<Tier | "wrong", string> = {
  famous: "🟦", well_known: "🟩", familiar: "🟨", obscure: "🟧", rarest: "🟥", wrong: "⬛",
};
