import { describe, expect, it } from "vitest";
import {
  assignPair, currentQuestion, formatShare, formatValue, moveItem, pairsComplete, remainingMs,
  stripLabel, untilNextPuzzle, withArticle,
} from "./state";
import type { DayQuestion } from "./types";

const q = (idx: number, state: DayQuestion["play"]["state"], points = 0): DayQuestion => ({
  idx, kind: "free_text", family: "Flags", difficulty: 1, play: { state, seconds: 20 }, points,
});

describe("progress", () => {
  it("is on the first question that isn't done", () => {
    expect(currentQuestion([q(0, "done"), q(1, "playing"), q(2, "not_started")])).toBe(1);
    expect(currentQuestion([q(0, "done"), q(1, "not_started")])).toBe(1);
    expect(currentQuestion([q(0, "done"), q(1, "done")])).toBeNull();
  });
  it("labels the strip", () => {
    expect(stripLabel(q(0, "done", 85), 1)).toBe("1 · 85");
    expect(stripLabel(q(1, "playing"), 2)).toBe("2 ⏱");
    expect(stripLabel(q(2, "not_started"), 3)).toBe("3");
  });
  it("counts down on the server's clock", () => {
    const deadline = "2026-11-20T12:00:20.000Z";
    const now = Date.parse("2026-11-20T12:00:05.000Z");
    expect(remainingMs(deadline, 0, now)).toBe(15_000);
    expect(remainingMs(deadline, 3_000, now)).toBe(12_000); // client clock 3 s behind
    expect(remainingMs(deadline, 0, now + 60_000)).toBe(0);
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

describe("ordering", () => {
  it("moves items up and down", () => {
    expect(moveItem([0, 1, 2, 3], 2, 1)).toEqual([0, 2, 1, 3]);
    expect(moveItem([0, 1, 2, 3], 0, -1)).toEqual([0, 1, 2, 3]);
    expect(moveItem([0, 1, 2, 3], 3, 4)).toEqual([0, 1, 2, 3]);
  });
  it("formats values", () => {
    expect(formatValue(2012, "year")).toBe("2012");
    expect(formatValue(1234567.4, "people")).toBe("1,234,567 people");
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
});
