/**
 * Submitting an answer (PLAN.md §1, §6, §7).
 *
 * - "did you mean" never uses up the question (PLAN §1).
 * - Unrecognised input gets MAX_UNRECOGNISED_ATTEMPTS tries before it counts as a 0-point answer.
 *   This can't leak answers: "unrecognised" says nothing about validity. Every unrecognised input
 *   is logged to unmatched_log for the alias-fixing page.
 * - One answer per player and question (unique constraint); resubmitting returns the stored result.
 * - Points are awarded immediately from the blended share (scoring.ts); the nightly finalise job
 *   (finalize.ts) stores final points too.
 * - When the player has answered every question of the day, daily_scores and player_stats update
 *   in the same transaction.
 */
import type { Pool, PoolClient } from "pg";
import { matchAnswer, type MatchResult } from "../matcher";
import { normalize } from "../normalize";
import { loadPuzzle, type PuzzleQuestion } from "./puzzle";
import { matchPoints, scoreAnswer, type Tier } from "./scoring";
import { refreshPlayerStats } from "./stats";

export const MAX_UNRECOGNISED_ATTEMPTS = 3;
const MAX_TEXT_LENGTH = 120;

export class GameError extends Error {
  constructor(public code: string, message: string, public httpStatus = 400) {
    super(message);
  }
}

export interface AnswerInput {
  playerId: string;
  date: string;
  idx: number;
  /** free-text questions */
  text?: string;
  confirmEntityId?: string;
  /** matching rounds: pairs[leftPos] = rightPos */
  pairs?: number[];
  /** the current UTC date (injectable for tests) */
  today: string;
}

export interface NamedEntity {
  id: string;
  name: string;
}

export interface AnswerResult {
  status: "valid" | "real_but_wrong" | "unrecognised" | "did_you_mean" | "match";
  /** true if this question is now done for the player */
  final: boolean;
  alreadyAnswered?: boolean;
  entity?: NamedEntity & { partOf?: string };
  suggestion?: NamedEntity;
  alternative?: NamedEntity;
  otherType?: string;
  attemptsLeft?: number;
  points: number;
  tier?: Tier;
  share?: number;
  commonAnswers?: NamedEntity[];
  rareAnswers?: NamedEntity[];
  /** matching rounds */
  correct?: boolean[];
  solution?: number[];
  /** set when this answer completed the day */
  dayComplete?: { total: number };
}

async function getQuestion(db: Pool, date: string, idx: number, today: string) {
  if (date !== today) {
    throw new GameError("not_today", "Only today's puzzle can be answered", 409);
  }
  const puzzle = await loadPuzzle(db, date);
  const q = puzzle?.find((x) => x.idx === idx);
  if (!puzzle || !q) throw new GameError("no_question", "No such question", 404);
  return { puzzle, q };
}

export async function submitAnswer(db: Pool, input: AnswerInput): Promise<AnswerResult> {
  const { puzzle, q } = await getQuestion(db, input.date, input.idx, input.today);
  const existing = await storedResult(db, input.playerId, q);
  if (existing) return existing;
  return q.kind === "match" ? submitMatch(db, input, q, puzzle) : submitText(db, input, q, puzzle);
}

// ------------------------------------------------------------------ free text

async function submitText(
  db: Pool, input: AnswerInput, q: PuzzleQuestion, puzzle: PuzzleQuestion[],
): Promise<AnswerResult> {
  const raw = (input.text ?? "").slice(0, MAX_TEXT_LENGTH);
  if (!raw.trim()) throw new GameError("empty", "Type an answer");
  const m = await matchAnswer(db, raw, {
    entityType: q.entityType, validIds: q.validIds, confirmEntityId: input.confirmEntityId,
  });

  if (m.status === "did_you_mean") {
    return {
      status: "did_you_mean", final: false, points: 0,
      suggestion: m.suggestion && { id: m.suggestion.id, name: m.suggestion.name },
      ...(m.alternative ? { alternative: { id: m.alternative.id, name: m.alternative.name } } : {}),
    };
  }
  if (m.status === "unrecognised") return handleUnrecognised(db, input, q, puzzle, raw, m);

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const ins = await client.query<{ id: string }>(
      `INSERT INTO answers (player_id, date, idx, raw_text, matched_entity_id, valid, points,
                            status, kind, detail)
       VALUES ($1, $2, $3, $4, $5, $6, 0, $7, 'free_text', $8)
       ON CONFLICT (player_id, date, idx) DO NOTHING RETURNING id`,
      [input.playerId, q.date, q.idx, raw, m.entity!.id, m.status === "valid", m.status,
       JSON.stringify(m.namesakes?.length ? { namesakes: m.namesakes.map((n) => n.id) } : {})],
    );
    if (!ins.rows.length) {
      await client.query("ROLLBACK");
      return (await storedResult(db, input.playerId, q))!; // a concurrent duplicate submission
    }
    const nSame = (await client.query<{ n: number }>(
      `INSERT INTO answer_counts (date, idx, entity_id, n) VALUES ($1, $2, $3, 1)
       ON CONFLICT (date, idx, entity_id) DO UPDATE SET n = answer_counts.n + 1 RETURNING n`,
      [q.date, q.idx, m.entity!.id],
    )).rows[0].n;
    let points = 0;
    let tier: Tier | undefined;
    let share: number | undefined;
    if (m.status === "valid") {
      const nTotal = await totalAnswers(client, q);
      ({ points, tier, share } = scoreAnswer(nSame, nTotal, q.prior.get(m.entity!.id) ?? 0));
      await client.query(
        "UPDATE answers SET points = $1, tier = $2, share = $3 WHERE id = $4",
        [points, tier, share, ins.rows[0].id],
      );
    }
    const dayComplete = await afterAnswer(client, input.playerId, puzzle, input.today);
    await client.query("COMMIT");
    return {
      status: m.status, final: true, points, tier, share,
      entity: { id: m.entity!.id, name: m.entity!.name,
                ...(m.entity!.partOf ? { partOf: m.entity!.partOf } : {}) },
      ...(await reveal(client, q)),
      ...(dayComplete ? { dayComplete } : {}),
    };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function handleUnrecognised(
  db: Pool, input: AnswerInput, q: PuzzleQuestion, puzzle: PuzzleQuestion[], raw: string,
  m: MatchResult,
): Promise<AnswerResult> {
  const logged = normalize(raw) || raw.trim().toLowerCase();
  await db.query(
    `INSERT INTO unmatched_log (date, idx, raw_text, n) VALUES ($1, $2, $3, 1)
     ON CONFLICT (date, idx, raw_text) DO UPDATE SET n = unmatched_log.n + 1`,
    [q.date, q.idx, logged],
  );
  const attempts = (await db.query<{ n: number }>(
    `INSERT INTO answer_attempts (player_id, date, idx, n) VALUES ($1, $2, $3, 1)
     ON CONFLICT (player_id, date, idx) DO UPDATE SET n = answer_attempts.n + 1 RETURNING n`,
    [input.playerId, q.date, q.idx],
  )).rows[0].n;
  const left = MAX_UNRECOGNISED_ATTEMPTS - attempts;
  const hint = m.otherType ? { otherType: m.otherType } : {};
  if (left > 0) return { status: "unrecognised", final: false, points: 0, attemptsLeft: left, ...hint };

  // out of attempts: record a 0-point answer
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO answers (player_id, date, idx, raw_text, valid, points, status, kind)
       VALUES ($1, $2, $3, $4, false, 0, 'unrecognised', 'free_text')
       ON CONFLICT (player_id, date, idx) DO NOTHING`,
      [input.playerId, q.date, q.idx, raw],
    );
    const dayComplete = await afterAnswer(client, input.playerId, puzzle, input.today);
    await client.query("COMMIT");
    return {
      status: "unrecognised", final: true, points: 0, attemptsLeft: 0, ...hint,
      ...(await reveal(client, q)), ...(dayComplete ? { dayComplete } : {}),
    };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ------------------------------------------------------------------ matching rounds

async function submitMatch(
  db: Pool, input: AnswerInput, q: PuzzleQuestion, puzzle: PuzzleQuestion[],
): Promise<AnswerResult> {
  const n = q.pairs.length;
  const pairs = input.pairs;
  if (!Array.isArray(pairs) || pairs.length !== n ||
      !pairs.every((p) => Number.isInteger(p) && p >= 0 && p < n) || new Set(pairs).size !== n) {
    throw new GameError("bad_pairs", `Pair each of the ${n} items with a different option`);
  }
  const correct = q.pairs.map((p, i) => q.rightOrder[pairs[i]] === p.right);
  const points = matchPoints(q.pairs.filter((_, i) => correct[i]));
  const solution = q.pairs.map((p) => q.rightOrder.indexOf(p.right));
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const ins = await client.query(
      `INSERT INTO answers (player_id, date, idx, raw_text, valid, points, final_points, status,
                            kind, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $6, 'match', 'match', $7)
       ON CONFLICT (player_id, date, idx) DO NOTHING RETURNING id`,
      [input.playerId, q.date, q.idx, JSON.stringify(pairs), correct.every(Boolean), points,
       JSON.stringify({ pairs, correct })],
    );
    if (!ins.rows.length) {
      await client.query("ROLLBACK");
      return (await storedResult(db, input.playerId, q))!;
    }
    const dayComplete = await afterAnswer(client, input.playerId, puzzle, input.today);
    await client.query("COMMIT");
    return { status: "match", final: true, points, correct, solution,
             ...(dayComplete ? { dayComplete } : {}) };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ------------------------------------------------------------------ shared

async function totalAnswers(db: Pool | PoolClient, q: PuzzleQuestion): Promise<number> {
  return Number((await db.query<{ n: string }>(
    "SELECT count(*) AS n FROM answers WHERE date = $1 AND idx = $2", [q.date, q.idx],
  )).rows[0].n);
}

/** After an answer: keep daily_scores current; on the last question, refresh player stats. */
async function afterAnswer(
  client: PoolClient, playerId: string, puzzle: PuzzleQuestion[], today: string,
): Promise<{ total: number } | null> {
  const date = puzzle[0].date;
  const { rows } = await client.query<{ n: string; total: string }>(
    "SELECT count(*) AS n, coalesce(sum(points), 0) AS total FROM answers WHERE player_id = $1 AND date = $2",
    [playerId, date],
  );
  const done = Number(rows[0].n) >= puzzle.length;
  const total = Number(rows[0].total);
  await client.query(
    `INSERT INTO daily_scores (date, player_id, instant_points, finished) VALUES ($1, $2, $3, $4)
     ON CONFLICT (date, player_id) DO UPDATE SET instant_points = $3, finished = $4`,
    [date, playerId, total, done],
  );
  if (!done) return null;
  await refreshPlayerStats(client, playerId, today);
  return { total };
}

/** The reveal after answering: a few of the most common and of the rarest valid answers. */
async function reveal(db: Pool | PoolClient, q: PuzzleQuestion): Promise<{ commonAnswers: NamedEntity[]; rareAnswers: NamedEntity[] }> {
  const counts = new Map((await db.query<{ entity_id: string; n: number }>(
    "SELECT entity_id, n FROM answer_counts WHERE date = $1 AND idx = $2 AND entity_id = ANY($3)",
    [q.date, q.idx, q.validIds],
  )).rows.map((r) => [r.entity_id, r.n]));
  const byPrior = [...q.validIds].sort((a, b) => (q.prior.get(b) ?? 0) - (q.prior.get(a) ?? 0));
  const given = byPrior.filter((id) => counts.has(id));
  // Until enough people have played, fall back to the popularity prior.
  const common = (given.length >= 3
    ? [...given].sort((a, b) => counts.get(b)! - counts.get(a)!)
    : byPrior).slice(0, 3);
  const rarePool = given.length >= 6 ? [...given].sort((a, b) => counts.get(a)! - counts.get(b)!)
    : [...byPrior].reverse();
  const rare = rarePool.filter((id) => !common.includes(id)).slice(0, 3);
  const names = new Map((await db.query<{ id: string; name: string }>(
    "SELECT id, name FROM entities WHERE id = ANY($1)", [[...common, ...rare]],
  )).rows.map((r) => [r.id, r.name]));
  const named = (ids: string[]) => ids.map((id) => ({ id, name: names.get(id) ?? id }));
  return { commonAnswers: named(common), rareAnswers: named(rare) };
}

/** The stored result for a question the player already answered, or null. */
async function storedResult(db: Pool, playerId: string, q: PuzzleQuestion): Promise<AnswerResult | null> {
  const { rows } = await db.query<{
    status: string; points: number; tier: Tier | null; share: number | null;
    matched_entity_id: string | null; name: string | null; detail: { correct?: boolean[] };
  }>(
    `SELECT a.status, a.points, a.tier, a.share, a.matched_entity_id, e.name, a.detail
     FROM answers a LEFT JOIN entities e ON e.id = a.matched_entity_id
     WHERE a.player_id = $1 AND a.date = $2 AND a.idx = $3`,
    [playerId, q.date, q.idx],
  );
  const r = rows[0];
  if (!r) return null;
  if (q.kind === "match") {
    return { status: "match", final: true, alreadyAnswered: true, points: r.points,
             correct: r.detail.correct, solution: q.pairs.map((p) => q.rightOrder.indexOf(p.right)) };
  }
  return {
    status: r.status as AnswerResult["status"], final: true, alreadyAnswered: true,
    points: r.points, tier: r.tier ?? undefined, share: r.share ?? undefined,
    ...(r.matched_entity_id ? { entity: { id: r.matched_entity_id, name: r.name ?? "" } } : {}),
    ...(await reveal(db, q)),
  };
}
