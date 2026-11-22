/**
 * Phase 4 "done when": simulate 500 players and check that tiers distribute sensibly
 * (PLAN.md §8), under the timed one-correct-answer rules of 2026-11-20. Runs against the local
 * database on sandbox dates in 1999 (copies of real generated puzzles) and removes everything it
 * created. Skipped if the database is unreachable.
 */
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../db";
import { normalize } from "../normalize";
import {
  endQuestion, GameError, GRACE_MS, QUESTION_SECONDS, startQuestion, submitAnswer,
  type AnswerResult, type QuestionSummary,
} from "./answer";
import { finalizeDay } from "./finalize";
import { clearPuzzleCache, loadPuzzle } from "./puzzle";
import { getResults } from "./results";
import { refreshPlayerStats } from "./stats";

const DAY1 = "1999-01-01";
const DAY2 = "1999-01-02";
const PLAYERS = 500;
const CONCURRENCY = 10;

let db: Pool | null = null;
const players: string[] = [];

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function cleanup(pool: Pool) {
  for (const d of [DAY1, DAY2]) {
    await pool.query("DELETE FROM daily_scores WHERE date = $1", [d]);
    await pool.query("DELETE FROM question_plays WHERE date = $1", [d]);
    await pool.query("DELETE FROM unmatched_log WHERE date = $1", [d]);
    await pool.query("DELETE FROM answer_counts WHERE date = $1", [d]);
    await pool.query("DELETE FROM answers WHERE date = $1", [d]);
    await pool.query("DELETE FROM daily_puzzles WHERE date = $1", [d]);
  }
  if (players.length) await pool.query("DELETE FROM players WHERE id = ANY($1)", [players]);
}

/** Copy a generated day (with a matching round) onto a sandbox date. */
async function copyPuzzle(pool: Pool, to: string, nth: number) {
  const { rows } = await pool.query<{ date: string }>(
    `SELECT to_char(date, 'YYYY-MM-DD') AS date FROM puzzle_questions
     WHERE date > '2000-01-01' GROUP BY date HAVING bool_or(kind = 'order') AND bool_or(kind = 'match')
     ORDER BY date OFFSET $1 LIMIT 1`,
    [nth],
  );
  if (!rows[0]) throw new Error("no generated puzzles to copy: run make generate");
  await pool.query("INSERT INTO daily_puzzles (date) VALUES ($1)", [to]);
  await pool.query(
    `INSERT INTO puzzle_questions (date, idx, template_id, params, question_text, valid_entity_ids,
       family, entity_type, difficulty, stats, kind, payload)
     SELECT $1, idx, template_id, params, question_text, valid_entity_ids, family, entity_type,
       difficulty, stats, kind, payload FROM puzzle_questions WHERE date = $2`,
    [to, rows[0].date],
  );
}

async function newPlayer(pool: Pool): Promise<string> {
  const id = randomUUID();
  await pool.query("INSERT INTO players (id) VALUES ($1)", [id]);
  players.push(id);
  return id;
}

beforeAll(async () => {
  try {
    const pool = getPool();
    await pool.query("SELECT 1");
    db = pool;
  } catch {
    db = null;
    return;
  }
  await cleanup(db);
  await copyPuzzle(db, DAY1, 0);
  await copyPuzzle(db, DAY2, 1);
  clearPuzzleCache();
}, 60_000);

afterAll(async () => {
  if (db) await cleanup(db);
  await closePool();
}, 60_000);

const asAnswer = (r: AnswerResult | QuestionSummary) => r as AnswerResult;

/**
 * A player's attempts at one free-text question: sometimes a wrong place or junk first, then one
 * right answer drawn the way the scoring's cold-start model assumes (most popular ~30% of
 * answers, falling off with popularity), with typos; some players give up.
 */
function makeChooser(
  valid: { id: string; name: string }[],
  wrong: { id: string; name: string }[],
  rand: () => number,
  prior: Map<string, number>,
) {
  return (): { text: string; intended?: string }[] => {
    const pool = valid.map((v) => ({ v, w: prior.get(v.id) ?? 0 }));
    const out: { text: string; intended?: string }[] = [];
    if (rand() < 0.2 && wrong.length) out.push({ text: wrong[Math.floor(rand() * wrong.length)].name });
    if (rand() < 0.05) out.push({ text: `qzx${Math.floor(rand() * 1e6)}vv` });
    if (rand() < 0.08) return out; // gives up
    const total = pool.reduce((a, b) => a + b.w, 0);
    let x = rand() * total;
    let i = pool.length - 1;
    for (let j = 0; j < pool.length; j++) {
      x -= pool[j].w;
      if (x <= 0) { i = j; break; }
    }
    const pick = pool[i].v;
    // 8% typos: drop one letter (comes back as "did you mean")
    if (rand() < 0.08 && pick.name.length > 7) {
      const c = 1 + Math.floor(rand() * (pick.name.length - 2));
      out.push({ text: pick.name.slice(0, c) + pick.name.slice(c + 1), intended: pick.id });
    } else {
      out.push({ text: pick.name, intended: pick.id });
    }
    return out;
  };
}

describe("game API logic (needs the DB)", () => {
  it("handles the clock, order, duplicates, corrections and secrecy", async (ctx) => {
    if (!db) ctx.skip();
    const pool = db!;
    const puzzle = (await loadPuzzle(pool, DAY1))!;
    const q0 = puzzle[0];
    const p = await newPlayer(pool);
    const t0 = new Date("1999-01-01T12:00:00Z");
    const at = (s: number) => new Date(t0.getTime() + s * 1000);
    const base = { playerId: p, date: DAY1, today: DAY1 };

    // wrong day, not started, out of order
    await expect(startQuestion(pool, { ...base, idx: q0.idx, today: DAY2 })).rejects.toThrow(GameError);
    await expect(submitAnswer(pool, { ...base, idx: q0.idx, text: "France", now: t0 }))
      .rejects.toMatchObject({ code: "not_started" });
    await expect(startQuestion(pool, { ...base, idx: puzzle[1].idx, now: t0 }))
      .rejects.toMatchObject({ code: "out_of_order" });

    // start: text + deadline, no secrets
    const st = await startQuestion(pool, { ...base, idx: q0.idx, now: t0 });
    expect(st.play.state).toBe("playing");
    expect(Date.parse(st.play.deadline!) - t0.getTime()).toBe(QUESTION_SECONDS.free_text * 1000);
    const pub = JSON.stringify(st);
    for (const id of q0.validIds) expect(pub).not.toContain(`"${id}"`);

    // wrong answers can be retried (a repeat is "duplicate"); junk costs nothing
    const names = (await pool.query<{ id: string; name: string }>(
      "SELECT id, name FROM entities WHERE id = ANY($1) ORDER BY popularity DESC NULLS LAST LIMIT 3",
      [q0.validIds])).rows;
    const wrongName = (await pool.query<{ name: string }>(
      `SELECT name FROM entities WHERE type = $1 AND NOT (id = ANY($2)) AND name ~ '^[A-Za-z ]+$'
       ORDER BY popularity DESC NULLS LAST LIMIT 1`, [q0.entityType, q0.validIds])).rows[0].name;
    const w1 = asAnswer(await submitAnswer(pool, { ...base, idx: q0.idx, text: wrongName, now: at(1) }));
    expect(w1.status).toBe("real_but_wrong");
    expect(w1.summary).toBeUndefined();
    expect(asAnswer(await submitAnswer(pool, { ...base, idx: q0.idx, text: wrongName, now: at(2) })).status)
      .toBe("duplicate");
    expect(asAnswer(await submitAnswer(pool, { ...base, idx: q0.idx, text: "qqqqzzzz", now: at(3) })).status)
      .toBe("unrecognised");

    // a misspelling is suggested, not recorded (pick one that isn't itself someone's alias)
    const longs = (await pool.query<{ name: string }>(
      `SELECT name FROM entities WHERE id = ANY($1) AND length(name) >= 9 AND name ~ '^[A-Za-z ]+$'
       ORDER BY popularity DESC NULLS LAST LIMIT 10`, [q0.validIds])).rows;
    let typo = "";
    for (const { name } of longs) {
      const t = name.slice(0, 4) + name.slice(5);
      const hit = await pool.query("SELECT 1 FROM aliases WHERE alias_norm = $1 LIMIT 1", [normalize(t, q0.entityType)]);
      if (!hit.rows.length) { typo = t; break; }
    }
    expect(typo, "no usable typo in this puzzle").not.toBe("");
    const dym = asAnswer(await submitAnswer(pool, { ...base, idx: q0.idx, text: typo, now: at(7) }));
    expect(dym.status).toBe("did_you_mean");
    expect(dym.questionPoints).toBe(0);

    // the first correct answer is final: it scores, ends the question and brings the reveal
    const a1 = asAnswer(await submitAnswer(pool, { ...base, idx: q0.idx, text: names[0].name, now: at(8) }));
    expect(a1.status).toBe("valid");
    expect(a1.points).toBeGreaterThan(0);
    expect(a1.summary?.points).toBe(a1.points);
    expect(a1.summary?.answers.map((a) => a.status)).toEqual(["real_but_wrong", "valid"]);
    expect(a1.summary?.commonAnswers?.length).toBeGreaterThan(0);
    await expect(submitAnswer(pool, { ...base, idx: q0.idx, text: names[1].name, now: at(9) }))
      .rejects.toMatchObject({ code: "time_up" });
    const late = at(QUESTION_SECONDS.free_text + GRACE_MS / 1000 + 1);
    const sum = await endQuestion(pool, { ...base, idx: q0.idx, now: late });
    expect(sum.points).toBe(a1.points);

    // next question can start now; a later one can't
    await startQuestion(pool, { ...base, idx: puzzle[1].idx, now: late });
    await expect(startQuestion(pool, { ...base, idx: puzzle[2].idx, now: late }))
      .rejects.toMatchObject({ code: "out_of_order" });
  });

  it(`simulates ${PLAYERS} players; tiers distribute sensibly`, async (ctx) => {
    if (!db) ctx.skip();
    const pool = db!;
    const puzzle = (await loadPuzzle(pool, DAY1))!;
    const rand = mulberry32(20261120);
    const choosers = new Map<number, () => { text: string; intended?: string }[]>();
    for (const q of puzzle.filter((x) => x.kind === "free_text")) {
      const valid = (await pool.query<{ id: string; name: string }>(
        "SELECT id, name FROM entities WHERE id = ANY($1)", [q.validIds],
      )).rows;
      const wrong = (await pool.query<{ id: string; name: string }>(
        `SELECT id, name FROM entities WHERE type = $1 AND NOT (id = ANY($2))
         ORDER BY popularity DESC NULLS LAST LIMIT 40`,
        [q.entityType, q.validIds],
      )).rows;
      choosers.set(q.idx, makeChooser(valid, wrong, rand, q.prior));
    }

    const ids: string[] = [];
    for (let i = 0; i < PLAYERS; i++) ids.push(await newPlayer(pool));
    const statuses: Record<string, number> = {};
    const count = (k: string) => { statuses[k] = (statuses[k] ?? 0) + 1; };
    const play = async (playerId: string) => {
      const base = { playerId, date: DAY1, today: DAY1 };
      for (const q of puzzle) {
        await startQuestion(pool, { ...base, idx: q.idx });
        if (q.kind === "match") {
          const pairs = q.pairs.map((p) => q.rightOrder.indexOf(p.right));
          if (rand() < 0.5) [pairs[0], pairs[1]] = [pairs[1], pairs[0]];
          const last = pairs.length - 1;
          if (rand() < 0.3) [pairs[1], pairs[last]] = [pairs[last], pairs[1]];
          if (rand() < 0.1) pairs[last] = -1;
          await submitAnswer(pool, { ...base, idx: q.idx, pairs });
          count("match");
          continue;
        }
        if (q.kind === "order") {
          const order = [...q.answer];
          if (rand() < 0.6) [order[1], order[2]] = [order[2], order[1]];
          if (rand() < 0.3) [order[3], order[4]] = [order[4], order[3]];
          await submitAnswer(pool, { ...base, idx: q.idx, order });
          count("order");
          continue;
        }
        let done = false;
        for (const choice of choosers.get(q.idx)!()) {
          let r = asAnswer(await submitAnswer(pool, { ...base, idx: q.idx, text: choice.text }));
          if (r.status === "did_you_mean") {
            count("did_you_mean");
            r = asAnswer(await submitAnswer(pool, {
              ...base, idx: q.idx, text: choice.text, confirmEntityId: r.suggestion!.id,
            }));
          }
          count(r.status);
          if (r.summary) { done = true; break; }
        }
        if (!done) await endQuestion(pool, { ...base, idx: q.idx });
      }
    };
    const t0 = Date.now();
    for (let i = 0; i < ids.length; i += CONCURRENCY) {
      await Promise.all(ids.slice(i, i + CONCURRENCY).map(play));
    }
    const seconds = (Date.now() - t0) / 1000;

    // everyone finished, with stats
    const fin = await pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM daily_scores WHERE date = $1 AND finished AND player_id = ANY($2)",
      [DAY1, ids],
    );
    expect(Number(fin.rows[0].n)).toBe(PLAYERS);
    const st = await pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM player_stats WHERE games_played = 1 AND player_id = ANY($1)", [ids],
    );
    expect(Number(st.rows[0].n)).toBe(PLAYERS);

    // tier distribution of valid free-text answers (instant scoring)
    const tiers = Object.fromEntries((await pool.query<{ tier: string; n: string }>(
      `SELECT tier, count(*) AS n FROM answers WHERE date = $1 AND status = 'valid'
       AND player_id = ANY($2) GROUP BY tier`, [DAY1, ids],
    )).rows.map((r) => [r.tier, Number(r.n)]));
    const nValid = Object.values(tiers).reduce((a, b) => a + b, 0);
    const pct = (t: string) => (100 * (tiers[t] ?? 0)) / nValid;

    await finalizeDay(pool, DAY1, DAY1);
    const finalTiers = Object.fromEntries((await pool.query<{ tier: string; n: string }>(
      `SELECT final_tier AS tier, count(*) AS n FROM answers WHERE date = $1 AND status = 'valid'
       AND player_id = ANY($2) GROUP BY final_tier`, [DAY1, ids],
    )).rows.map((r) => [r.tier, Number(r.n)]));
    const totals = (await pool.query<{ instant: number; final: number }>(
      `SELECT instant_points AS instant, final_points AS final FROM daily_scores
       WHERE date = $1 AND player_id = ANY($2)`, [DAY1, ids],
    )).rows;
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const perQuestion = (await pool.query<{ idx: number; n: number; final_points: number }>(
      `SELECT c.idx, c.n, max(a.final_points) AS final_points FROM answer_counts c
       JOIN answers a ON a.date = c.date AND a.idx = c.idx AND a.matched_entity_id = c.entity_id
       WHERE c.date = $1 AND a.status = 'valid' GROUP BY c.idx, c.n, c.entity_id`, [DAY1],
    )).rows;

    console.log([
      `simulated ${PLAYERS} players in ${seconds.toFixed(1)} s`,
      `outcomes: ${JSON.stringify(statuses)}`,
      `instant tiers (% of ${nValid} valid answers): ` +
        ["famous", "well_known", "familiar", "obscure", "rarest"].map((t) => `${t} ${pct(t).toFixed(1)}`).join(", "),
      `final tiers: ${JSON.stringify(finalTiers)}`,
      `mean day score: instant ${mean(totals.map((t) => t.instant)).toFixed(0)}, ` +
        `final ${mean(totals.map((t) => t.final)).toFixed(0)}; ` +
        `min ${Math.min(...totals.map((t) => t.final))}, max ${Math.max(...totals.map((t) => t.final))}`,
    ].join("\n"));

    for (const t of ["famous", "well_known", "familiar", "obscure", "rarest"]) {
      expect(tiers[t] ?? 0, `tier ${t} never awarded`).toBeGreaterThan(0);
    }
    expect(pct("famous") + pct("well_known")).toBeGreaterThan(25); // common answers are common
    expect(pct("rarest")).toBeLessThan(30); // 100 points stays special
    // after finalising, a more common answer never scores more than a rarer one
    for (const idx of new Set(perQuestion.map((r) => r.idx))) {
      const rows = perQuestion.filter((r) => r.idx === idx).sort((a, b) => b.n - a.n);
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i].final_points).toBeGreaterThanOrEqual(rows[i - 1].final_points);
      }
    }

    const res = (await getResults(pool, ids[0], DAY1, DAY1))!;
    expect(res.finished).toBe(true);
    expect(res.percentile).not.toBeNull();
    expect(res.shareText).toContain(DAY1);
  }, 600_000);

  it("closes questions left running, streaks across days, rebuilt stats equal incremental", async (ctx) => {
    if (!db) ctx.skip();
    const pool = db!;
    const p = await newPlayer(pool);
    for (const [day, today] of [[DAY1, DAY1], [DAY2, DAY2]]) {
      const puzzle = (await loadPuzzle(pool, day))!;
      let now = new Date(`${day}T10:00:00Z`);
      for (const q of puzzle) {
        const base = { playerId: p, date: day, today, idx: q.idx };
        await startQuestion(pool, { ...base, now });
        if (q.kind === "match") {
          await submitAnswer(pool, { ...base, now, pairs: q.pairs.map((x) => q.rightOrder.indexOf(x.right)) });
        } else if (q.kind === "order") {
          await submitAnswer(pool, { ...base, now, order: q.answer });
        } else {
          const name = (await pool.query<{ name: string }>(
            "SELECT name FROM entities WHERE id = ANY($1) ORDER BY popularity DESC NULLS LAST LIMIT 1",
            [q.validIds])).rows[0].name;
          await submitAnswer(pool, { ...base, now, text: name });
          // never press "I'm done": the next start closes it once the time has run out
        }
        now = new Date(now.getTime() + 60_000);
      }
      // the last question was left running: reading results after its time closes the day
      if (puzzle.at(-1)!.kind === "free_text") {
        await getResults(pool, p, day, today);
      }
    }
    const incremental = (await pool.query("SELECT * FROM player_stats WHERE player_id = $1", [p])).rows[0];
    expect(incremental.games_played).toBe(2);
    expect(incremental.current_streak).toBe(2);
    expect(incremental.max_streak).toBe(2);
    const rebuilt = await refreshPlayerStats(pool, p, DAY2);
    expect(rebuilt.gamesPlayed).toBe(2);
    expect(rebuilt.totalPoints).toBe(Number(incremental.total_points));
    expect((await refreshPlayerStats(pool, p, "1999-01-05")).currentStreak).toBe(0);
  }, 120_000);
});
