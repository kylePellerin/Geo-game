import { describe, expect, it } from "vitest";
import {
  assignPair, firstUnanswered, formatShare, nextUnanswered, pairsComplete, progressEmoji,
  untilNextPuzzle, withArticle,
} from "./state";
import type { Question } from "./types";

const qs = [0, 1, 2, 3, 4, 5].map((idx): Question => ({
  idx, kind: idx === 2 ? "match" : "free_text", text: `q${idx}`, family: "Flags", answerType: "country",
}));

describe("question order", () => {
  it("starts at the first unanswered question", () => {
    expect(firstUnanswered(qs, new Set())).toBe(0);
    expect(firstUnanswered(qs, new Set([0, 1]))).toBe(2);
    expect(firstUnanswered(qs, new Set([0, 1, 2, 3, 4, 5]))).toBeNull();
  });
  it("moves on and wraps round to skipped questions", () => {
    expect(nextUnanswered(qs, new Set([0]), 0)).toBe(1);
    expect(nextUnanswered(qs, new Set([1, 2, 3, 4, 5]), 5)).toBe(0);
    expect(nextUnanswered(qs, new Set([0, 1, 2, 3, 4, 5]), 3)).toBeNull();
  });
});

describe("matching pairs", () => {
  it("uses each right item once", () => {
    let p: (number | null)[] = [null, null, null, null];
    p = assignPair(p, 0, 2);
    p = assignPair(p, 1, 2);
    expect(p).toEqual([null, 2, null, null]);
    p = assignPair(p, 1, null);
    expect(p).toEqual([null, null, null, null]);
  });
  it("is complete only when every row has a pick", () => {
    expect(pairsComplete([0, 1, 2, null])).toBe(false);
    expect(pairsComplete([0, 1, 2, 3])).toBe(true);
    expect(pairsComplete([])).toBe(false);
  });
});

describe("formatting", () => {
  it("formats shares", () => {
    expect(formatShare(0.123)).toBe("12%");
    expect(formatShare(0.004)).toBe("<1%");
    expect(formatShare(0)).toBe("0%");
  });
  it("counts down to 00:00 UTC", () => {
    expect(untilNextPuzzle(new Date("2026-11-20T18:57:00Z"))).toBe("5h 03m");
    expect(untilNextPuzzle(new Date("2026-11-20T23:59:30Z"))).toBe("0h 01m");
  });
  it("picks the article", () => {
    expect(withArticle("airport")).toBe("an airport");
    expect(withArticle("city")).toBe("a city");
  });
  it("shows progress emoji", () => {
    expect(progressEmoji(undefined, qs[0])).toBe("▫️");
    expect(progressEmoji({ idx: 0, points: 50, tier: "familiar" }, qs[0])).toBe("🟨");
    expect(progressEmoji({ idx: 0, points: 0 }, qs[0])).toBe("⬛");
    expect(progressEmoji({ idx: 2, points: 25 }, qs[2])).toBe("🧩");
  });
});
