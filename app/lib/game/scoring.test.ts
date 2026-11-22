import { describe, expect, it } from "vitest";
import {
  blendWeight, estimatedShare, matchPoints, priorShares, scoreAnswer, tierFor,
} from "./scoring";

describe("tiers (PLAN §1)", () => {
  it.each([
    [0.5, "famous", 10], [0.21, "famous", 10], [0.2, "well_known", 25], [0.1, "familiar", 50],
    [0.06, "familiar", 50], [0.05, "obscure", 75], [0.03, "obscure", 75], [0.02, "rarest", 100],
    [0.001, "rarest", 100], [0, "rarest", 100],
  ])("share %f -> %s (%i)", (share, tier, points) => {
    expect(tierFor(share)).toEqual({ tier, points });
  });
});

describe("prior shares", () => {
  it("gives the most popular answer ~30% and sums to 1", () => {
    const pop = new Map(Array.from({ length: 40 }, (_, i) => [`e${i}`, 6 - i * 0.1]));
    const prior = priorShares(pop);
    const values = [...prior.values()];
    expect(values.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    expect(Math.max(...values)).toBeCloseTo(0.3, 2);
    expect(prior.get("e0")!).toBeGreaterThan(prior.get("e39")!);
  });

  it("is uniform when popularity is flat or the set is tiny", () => {
    expect([...priorShares(new Map([["a", 3], ["b", 3]])).values()]).toEqual([0.5, 0.5]);
    expect([...priorShares(new Map([["a", 5], ["b", 1], ["c", 0]])).values()].every(
      (v) => Math.abs(v - 1 / 3) < 1e-9)).toBe(true);
  });
});

describe("blending observed shares with the prior", () => {
  it("starts at the prior and converges to observed shares", () => {
    expect(blendWeight(0)).toBe(0);
    expect(blendWeight(50)).toBe(0.5);
    expect(estimatedShare(0, 0, 0.3)).toBeCloseTo(0.3);
    expect(estimatedShare(10, 1000, 0.3)).toBeCloseTo((1000 / 1050) * 0.01 + (50 / 1050) * 0.3);
  });

  it("a rare answer once many have played scores high", () => {
    expect(scoreAnswer(1, 2000, 0.001).tier).toBe("rarest");
    expect(scoreAnswer(900, 2000, 0.3).tier).toBe("famous");
  });
});

describe("matching rounds", () => {
  it("scores by the rarity of each correctly matched item", () => {
    expect(matchPoints([{ category: "famous" }, { category: "obscure" }])).toBe(60);
    expect(matchPoints([])).toBe(0);
  });
});
