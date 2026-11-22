/**
 * Hand-written questions (admin builder): saved on a sandbox date, then played through the same
 * game logic as generated ones. Needs the local database; skipped without it.
 */
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../db";
import { assertEditable, resolveNames, saveCustom } from "./admin";
import { endQuestion, startQuestion, submitAnswer, type AnswerResult, type QuestionSummary } from "./answer";
import { clearPuzzleCache, loadPuzzle, publicQuestions } from "./puzzle";

const DAY = "1999-01-20";
const TODAY = "1999-01-20";
let db: Pool | null = null;
const player = randomUUID();

async function cleanup(pool: Pool) {
  for (const t of ["daily_scores", "question_plays", "answer_counts", "unmatched_log", "answers", "daily_puzzles"]) {
    await pool.query(`DELETE FROM ${t} WHERE date = $1`, [DAY]);
  }
  await pool.query("DELETE FROM players WHERE id = $1", [player]);
}

beforeAll(async () => {
  try {
    db = getPool();
    await db.query("SELECT 1");
  } catch {
    db = null;
    return;
  }
  await cleanup(db);
  await db.query("INSERT INTO players (id) VALUES ($1)", [player]);
});

afterAll(async () => {
  if (db) await cleanup(db);
  await closePool();
});

describe("hand-written questions", () => {
  it("saves free text, matching and ordering questions that play like generated ones", async (ctx) => {
    if (!db) ctx.skip();
    const pool = db!;
    const { found, missing } = await resolveNames(pool, "country", ["France", "germany", "Côte d'Ivoire", "Narnia"]);
    expect(found.map((f) => f.name)).toEqual(expect.arrayContaining(["France", "Germany"]));
    expect(missing.map((m) => m.text)).toEqual(["Narnia"]);

    await expect(saveCustom(pool, DAY, 0, {
      kind: "free_text", text: "Name a country", entityType: "country", family: "countries", difficulty: 1,
      answerIds: [found[0].id],
    }, TODAY)).rejects.toThrow(/at least 3/);

    await saveCustom(pool, DAY, 0, {
      kind: "free_text", text: "Name a country hand-picked", entityType: "country", family: "countries",
      difficulty: 1, answerIds: found.map((f) => f.id),
    }, TODAY);
    const ids = (await pool.query<{ id: string; name: string }>(
      "SELECT id, name FROM entities WHERE type = 'country' AND name IN ('Spain', 'Italy', 'Japan', 'Peru')",
    )).rows;
    await saveCustom(pool, DAY, 1, {
      kind: "match", text: "Match each country to a word", difficulty: 2, display: "flags",
      pairs: ids.map((r, i) => ({ left: r.id, rightLabel: `word ${i}`, category: "familiar" })),
    }, TODAY);
    await saveCustom(pool, DAY, 2, {
      kind: "order", text: "Order these, largest first", difficulty: 2, unit: "km", direction: "desc",
      items: [{ label: "A", value: 1 }, { label: "B", value: 3 }, { label: "C", value: 2 }],
    }, TODAY);
    clearPuzzleCache();

    const puzzle = (await loadPuzzle(pool, DAY))!;
    expect(puzzle.map((q) => q.kind)).toEqual(["free_text", "match", "order"]);
    const pub = await publicQuestions(pool, puzzle);
    expect(pub[1].left?.every((l) => l.image?.startsWith("/api/image/"))).toBe(true);
    // the order round is never shown already sorted, and its answer is by value
    const order = puzzle[2];
    expect(order.items.map((it) => it.value)).not.toEqual([3, 2, 1]);
    expect(order.answer.map((p) => order.items[p].value)).toEqual([3, 2, 1]);

    const base = { playerId: player, date: DAY, today: TODAY };
    await startQuestion(pool, { ...base, idx: 0 });
    const r = await submitAnswer(pool, { ...base, idx: 0, text: "France" }) as AnswerResult;
    expect(r.status).toBe("valid");
    expect(r.summary).toBeDefined();
    // the player's own guess comes back with map coordinates; other players' answers don't
    expect(r.entity?.at).toEqual([expect.any(Number), expect.any(Number)]);
    expect(r.summary!.answers[0].entity.at).toEqual(r.entity?.at);
    expect([...(r.summary!.commonAnswers ?? []), ...(r.summary!.rareAnswers ?? [])].some((a) => "at" in a)).toBe(false);
    await startQuestion(pool, { ...base, idx: 1 });
    const m = await submitAnswer(pool, {
      ...base, idx: 1, pairs: puzzle[1].pairs.map((p) => puzzle[1].rightOrder.indexOf(p.right)),
    }) as QuestionSummary;
    expect(m.correct).toEqual([true, true, true, true]);
    await startQuestion(pool, { ...base, idx: 2 });
    const o = await submitAnswer(pool, { ...base, idx: 2, order: order.answer }) as QuestionSummary;
    expect(o.points).toBe(60);
    expect(o.dayComplete).toBeDefined();
    await endQuestion(pool, { ...base, idx: 2 });

    // played: now frozen
    await expect(assertEditable(pool, DAY, TODAY)).rejects.toThrow(/already has answers/);
  });
});
