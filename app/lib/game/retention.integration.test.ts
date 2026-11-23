/**
 * Phase 7: transfer codes (with history merge), delete my data, leaderboard and practice mode.
 * Plays two hand-written sandbox days. Needs the local database; skipped without it.
 */
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../db";
import { saveCustom, resolveNames } from "./admin";
import { endQuestion, startQuestion, submitAnswer, type AnswerResult, type QuestionSummary } from "./answer";
import { leaderboard } from "./leaderboard";
import { displayName } from "./names";
import { answerPractice, nextPractice, revealPractice } from "./practice";
import { clearPuzzleCache } from "./puzzle";
import { claimTransferCode, cleanCode, createTransferCode, deletePlayer, newCode } from "./transfer";

const DAY1 = "1999-01-21";
const DAY2 = "1999-01-22";
const TODAY = DAY2;
const IP = `test-${randomUUID()}`;
let db: Pool | null = null;
const a = randomUUID();
const b = randomUUID();

async function cleanup(pool: Pool) {
  for (const day of [DAY1, DAY2]) {
    for (const t of ["daily_scores", "question_plays", "answer_counts", "unmatched_log", "answers", "daily_puzzles"]) {
      await pool.query(`DELETE FROM ${t} WHERE date = $1`, [day]);
    }
  }
  await pool.query("DELETE FROM players WHERE id = ANY($1)", [[a, b]]);
  await pool.query("DELETE FROM claim_attempts WHERE key LIKE 'ip:test-%'");
}

async function play(pool: Pool, player: string, date: string, text: string) {
  const base = { playerId: player, date, today: date };
  await startQuestion(pool, { ...base, idx: 0 });
  const r = await submitAnswer(pool, { ...base, idx: 0, text }) as AnswerResult;
  expect(r.status).toBe("valid");
  await endQuestion(pool, { ...base, idx: 0 });
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
  await db.query("INSERT INTO players (id) VALUES ($1), ($2)", [a, b]);
  const { found } = await resolveNames(db, "country", ["France", "Germany", "Spain", "Italy"]);
  for (const day of [DAY1, DAY2]) {
    await saveCustom(db, day, 0, {
      kind: "free_text", text: "Name a country (test)", entityType: "country", family: "countries",
      difficulty: 1, answerIds: found.map((f) => f.id),
    }, "1999-01-01");
  }
  clearPuzzleCache();
});

afterAll(async () => {
  if (db) await cleanup(db);
  await closePool();
});

describe("transfer codes", () => {
  it("makes codes without look-alike characters", () => {
    for (let i = 0; i < 200; i++) expect(newCode()).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(cleanCode(" abcd-ef23 ")).toBe("ABCDEF23");
  });

  it("moves a player to a new device, merging that device's own days", async (ctx) => {
    if (!db) ctx.skip();
    const pool = db!;
    await play(pool, a, DAY1, "France");
    await play(pool, b, DAY1, "Germany"); // both played day 1: A's day 1 wins
    await play(pool, b, DAY2, "Spain"); // only B played day 2: it moves to A

    const { code } = await createTransferCode(pool, a);
    await expect(claimTransferCode(pool, "nope", b, IP, TODAY)).rejects.toThrow(/doesn't look right/);
    const r = await claimTransferCode(pool, code.toLowerCase(), b, IP, TODAY);
    expect(r).toEqual({ playerId: a, mergedDays: 1 });

    const days = (await pool.query<{ date: string; name: string }>(
      `SELECT to_char(a.date, 'YYYY-MM-DD') AS date, e.name FROM answers a
       JOIN entities e ON e.id = a.matched_entity_id WHERE a.player_id = $1 ORDER BY a.date`, [a],
    )).rows;
    expect(days).toEqual([{ date: DAY1, name: "France" }, { date: DAY2, name: "Spain" }]);
    expect((await pool.query("SELECT 1 FROM players WHERE id = $1", [b])).rowCount).toBe(0);
    const stats = (await pool.query("SELECT games_played, current_streak FROM player_stats WHERE player_id = $1", [a])).rows[0];
    expect(stats).toEqual({ games_played: 2, current_streak: 2 });

    // single use
    await expect(claimTransferCode(pool, code, null, IP, TODAY)).rejects.toThrow(/isn't valid/);
  });

  it("rate limits claims per IP", async (ctx) => {
    if (!db) ctx.skip();
    const ip = `test-${randomUUID()}`;
    for (let i = 0; i < 10; i++) await expect(claimTransferCode(db!, "AAAAAAAA", null, ip, TODAY)).rejects.toThrow(/isn't valid/);
    await expect(claimTransferCode(db!, "AAAAAAAA", null, ip, TODAY)).rejects.toThrow(/Too many tries/);
  });
});

describe("leaderboard", () => {
  it("ranks finished players under generated names", async (ctx) => {
    if (!db) ctx.skip();
    const board = await leaderboard(db!, DAY1, a);
    expect(board.players).toBe(1); // B's copy of day 1 went with B
    expect(board.you).toEqual({ rank: 1, name: displayName(a), points: expect.any(Number), you: true });
    expect(displayName(a)).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+ \d{2}$/);
    expect(displayName(a)).toBe(displayName(a));
    const other = await leaderboard(db!, DAY1, null);
    expect(other.you).toBeNull();
    expect(other.top[0].you).toBe(false);
  });
});

describe("delete my data", () => {
  it("removes the player and everything keyed to them", async (ctx) => {
    if (!db) ctx.skip();
    await deletePlayer(db!, a);
    for (const t of ["players", "answers", "question_plays", "daily_scores", "player_stats"]) {
      const col = t === "players" ? "id" : "player_id";
      expect((await db!.query(`SELECT 1 FROM ${t} WHERE ${col} = $1`, [a])).rowCount).toBe(0);
    }
  });
});

describe("practice", () => {
  it("serves questions without answers and checks answers statelessly", async (ctx) => {
    if (!db) ctx.skip();
    const pool = db!;
    const n = (await pool.query("SELECT count(*)::int AS n FROM practice_questions")).rows[0].n;
    if (!n) ctx.skip(); // run `make practice` first

    const next = await nextPractice(pool, "free_text", []);
    expect(next).not.toBeNull();
    expect(JSON.stringify(next)).not.toMatch(/valid|answer_rarity/);

    const row = (await pool.query<{ id: number; name: string }>(
      `SELECT p.id, e.name FROM practice_questions p
       JOIN LATERAL (SELECT e.name FROM entities e WHERE e.id = ANY(p.valid_entity_ids)
                     ORDER BY e.popularity DESC NULLS LAST LIMIT 1) e ON true
       WHERE p.kind = 'free_text' AND p.template_id = 'country_in_continent' LIMIT 1`,
    )).rows[0];
    // nothing stored: look only for this test's own texts (other test files insert answers in parallel)
    const word = `Atlantis ${randomUUID().slice(0, 8)}`;
    const stored = async () => (await pool.query(
      "SELECT count(*)::int AS n FROM answers WHERE raw_text = ANY($1)", [[row.name, word]],
    )).rows[0].n as number;
    const before = await stored();
    const r = await answerPractice(pool, { idx: row.id, text: row.name }) as AnswerResult;
    expect(r.status).toBe("valid");
    expect(r.tier).toBeDefined();
    expect(r.summary?.commonAnswers?.length).toBeGreaterThan(0);
    expect((await answerPractice(pool, { idx: row.id, text: word }) as AnswerResult).status).toBe("unrecognised");
    expect(await stored()).toBe(before);

    const m = await nextPractice(pool, "match", []);
    expect(m!.question.right!.length).toBeGreaterThan(m!.question.left!.length); // extra options
    const solution = (await revealPractice(pool, m!.question.idx)).solution!;
    const s = await answerPractice(pool, { idx: m!.question.idx, pairs: solution }) as QuestionSummary;
    expect(s.correct?.every(Boolean)).toBe(true);
    expect(s.points).toBeGreaterThan(0);
  });
});
