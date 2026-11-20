/**
 * Phase 4 "done when": simulate 500 players and check that tiers distribute sensibly
 * (PLAN.md §8). Runs against the local database on sandbox dates in 1999 (copies of real
 * generated puzzles) and removes everything it created. Skipped if the database is unreachable.
 */
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../db";
import { GameError, MAX_UNRECOGNISED_ATTEMPTS, submitAnswer } from "./answer";
import { finalizeDay } from "./finalize";
import { clearPuzzleCache, loadPuzzle, publicQuestions } from "./puzzle";
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
    await pool.query("DELETE FROM answer_attempts WHERE date = $1", [d]);
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
     WHERE kind = 'match' AND date > '2000-01-01' GROUP BY date ORDER BY date OFFSET $1 LIMIT 1`,
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

/**
 * Pick an answer the way the scoring's cold-start model assumes players do (PLAN §6: the most
 * popular answer gets ~30%, the rest fall off with popularity), plus wrong answers, junk and typos.
 */
function makeChooser(
  valid: { id: string; name: string; popularity: number }[],
  wrong: { id: string; name: string }[],
  rand: () => number,
  prior: Map<string, number>,
) {
  const weights = valid.map((v) => prior.get(v.id) ?? 0);
  const total = weights.reduce((a, b) => a + b, 0);
  return (): { text: string; intended?: string } => {
    const r = rand();
    if (r < 0.06 && wrong.length) {
      const w = wrong[Math.floor(rand() * wrong.length)];
      return { text: w.name };
    }
    if (r < 0.09) return { text: `qzx${Math.floor(rand() * 1e6)}vv` };
    let x = rand() * total;
    let pick = valid[valid.length - 1];
    for (let i = 0; i < valid.length; i++) {
      x -= weights[i];
      if (x <= 0) {
        pick = valid[i];
        break;
      }
    }
    // 8% typos: drop one letter (may trigger "did you mean")
    if (rand() < 0.08 && pick.name.length > 7) {
      const i = 1 + Math.floor(rand() * (pick.name.length - 2));
      return { text: pick.name.slice(0, i) + pick.name.slice(i + 1), intended: pick.id };
    }
    return { text: pick.name, intended: pick.id };
  };
}

describe("game API logic (needs the DB)", () => {
  it("handles edge cases: wrong day, duplicates, did-you-mean, unrecognised retries", async (ctx) => {
    if (!db) ctx.skip();
    const puzzle = (await loadPuzzle(db!, DAY1))!;
    const q = puzzle.find((x) => x.kind === "free_text")!;
    const p = await newPlayer(db!);
    await expect(submitAnswer(db!, { playerId: p, date: DAY1, idx: q.idx, text: "x", today: DAY2 }))
      .rejects.toThrow(GameError);

    // unrecognised: retries, then counts as 0
    for (let i = 1; i < MAX_UNRECOGNISED_ATTEMPTS; i++) {
      const r = await submitAnswer(db!, { playerId: p, date: DAY1, idx: q.idx, text: "qqqqzzzz", today: DAY1 });
      expect(r).toMatchObject({ status: "unrecognised", final: false, attemptsLeft: MAX_UNRECOGNISED_ATTEMPTS - i });
    }
    const last = await submitAnswer(db!, { playerId: p, date: DAY1, idx: q.idx, text: "qqqqzzzz", today: DAY1 });
    expect(last).toMatchObject({ status: "unrecognised", final: true, points: 0 });
    const again = await submitAnswer(db!, { playerId: p, date: DAY1, idx: q.idx, text: "France", today: DAY1 });
    expect(again.alreadyAnswered).toBe(true);

    // the public view never contains valid ids or the pairing
    const pub = JSON.stringify(await publicQuestions(db!, puzzle));
    for (const qq of puzzle) {
      for (const id of qq.validIds) expect(pub).not.toContain(`"${id}"`);
    }
  });

  it(`simulates ${PLAYERS} players; tiers distribute sensibly`, async (ctx) => {
    if (!db) ctx.skip();
    const pool = db!;
    const puzzle = (await loadPuzzle(pool, DAY1))!;
    const rand = mulberry32(20261120);
    const choosers = new Map<number, () => { text: string; intended?: string }>();
    for (const q of puzzle.filter((x) => x.kind === "free_text")) {
      const valid = (await pool.query<{ id: string; name: string; popularity: number }>(
        "SELECT id, name, coalesce(popularity, 0) AS popularity FROM entities WHERE id = ANY($1)",
        [q.validIds],
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
    const play = async (playerId: string) => {
      for (const q of puzzle) {
        if (q.kind === "match") {
          const solution = q.pairs.map((p) => q.rightOrder.indexOf(p.right));
          const pairs = [...solution];
          if (rand() < 0.35) [pairs[0], pairs[1]] = [pairs[1], pairs[0]];
          if (rand() < 0.15) [pairs[2], pairs[3]] = [pairs[3], pairs[2]];
          await submitAnswer(pool, { playerId, date: DAY1, idx: q.idx, pairs, today: DAY1 });
          statuses.match = (statuses.match ?? 0) + 1;
          continue;
        }
        const choice = choosers.get(q.idx)!();
        let r = await submitAnswer(pool, { playerId, date: DAY1, idx: q.idx, text: choice.text, today: DAY1 });
        for (let tries = 0; !r.final && tries < 5; tries++) {
          if (r.status === "did_you_mean") {
            statuses.did_you_mean = (statuses.did_you_mean ?? 0) + 1;
            r = await submitAnswer(pool, {
              playerId, date: DAY1, idx: q.idx, text: choice.text, today: DAY1,
              confirmEntityId: r.suggestion!.id,
            });
          } else {
            r = await submitAnswer(pool, { playerId, date: DAY1, idx: q.idx, text: choice.text, today: DAY1 });
          }
        }
        statuses[r.status] = (statuses[r.status] ?? 0) + 1;
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

    // sensible distribution
    for (const t of ["famous", "well_known", "familiar", "obscure", "rarest"]) {
      expect(tiers[t] ?? 0, `tier ${t} never awarded`).toBeGreaterThan(0);
    }
    expect(pct("famous") + pct("well_known")).toBeGreaterThan(30); // common answers are common
    expect(pct("rarest")).toBeLessThan(30); // 100 points stays special
    // after finalising, a more common answer never scores more than a rarer one
    for (const idx of new Set(perQuestion.map((r) => r.idx))) {
      const rows = perQuestion.filter((r) => r.idx === idx).sort((a, b) => b.n - a.n);
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i].final_points).toBeGreaterThanOrEqual(rows[i - 1].final_points);
      }
    }
    const meanFinal = mean(totals.map((t) => t.final));
    expect(meanFinal).toBeGreaterThan(60);
    expect(meanFinal).toBeLessThan(450);

    // results + percentile for a player
    const res = (await getResults(pool, ids[0], DAY1))!;
    expect(res.finished).toBe(true);
    expect(res.percentile).not.toBeNull();
    expect(res.shareText).toContain(DAY1);
  }, 600_000);

  it("streaks across consecutive days, and rebuilt stats equal incremental ones", async (ctx) => {
    if (!db) ctx.skip();
    const pool = db!;
    const p = await newPlayer(pool);
    for (const [day, today] of [[DAY1, DAY1], [DAY2, DAY2]]) {
      const puzzle = (await loadPuzzle(pool, day))!;
      for (const q of puzzle) {
        if (q.kind === "match") {
          await submitAnswer(pool, { playerId: p, date: day, idx: q.idx, today,
            pairs: q.pairs.map((x) => q.rightOrder.indexOf(x.right)) });
        } else {
          const name = (await pool.query<{ name: string }>(
            "SELECT name FROM entities WHERE id = ANY($1) ORDER BY popularity DESC NULLS LAST LIMIT 1",
            [q.validIds])).rows[0].name;
          await submitAnswer(pool, { playerId: p, date: day, idx: q.idx, text: name, today });
        }
      }
    }
    const incremental = (await pool.query("SELECT * FROM player_stats WHERE player_id = $1", [p])).rows[0];
    expect(incremental.games_played).toBe(2);
    expect(incremental.current_streak).toBe(2);
    expect(incremental.max_streak).toBe(2);
    const rebuilt = await refreshPlayerStats(pool, p, DAY2);
    expect(rebuilt.gamesPlayed).toBe(2);
    expect(rebuilt.totalPoints).toBe(Number(incremental.total_points));
    // two days later without playing, the current streak has lapsed
    expect((await refreshPlayerStats(pool, p, "1999-01-05")).currentStreak).toBe(0);
  }, 120_000);
});
