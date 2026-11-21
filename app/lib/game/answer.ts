/**
 * Playing a question (PLAN.md §1, §6, §7; rules of the 2026-11-20 playtests).
 *
 * - Questions are played in order. Starting one (startQuestion) shows its text and starts the
 *   clock: QUESTION_SECONDS for free text, more for matching rounds. The clock is the server's;
 *   answers arriving later than the deadline + GRACE_MS are refused.
 * - Free text: ONE correct answer. Wrong answers (real places that don't fit) score 0 and the
 *   player may try again until time runs out; the first valid answer is final, scores by rarity
 *   (scoring.ts) and ends the question. Unrecognised input costs nothing (and is logged to
 *   unmatched_log for the alias page).
 * - Spelling corrections are never applied silently: anything but an exact name/alias hit comes
 *   back as "did you mean", and only a confirm (confirm_entity_id) records it.
 * - Matching rounds: one submission of pairs (unpaired = -1, counts as wrong), which ends the
 *   question. Ordering rounds: one submission of the order, ORDER_POINTS_PER_ITEM per item in
 *   the right place. Running out of time without submitting scores 0.
 * - A question ends with a correct answer, "skip" (endQuestion), a round submit, or the deadline. Only then
 *   does the reveal (common/rare answers, matching solution) leave the server.
 * - When all of the day's questions have ended, daily_scores is marked finished and player_stats
 *   is refreshed in the same transaction.
 */
import type { Pool, PoolClient } from "pg";
import { matchAnswer, pinAt } from "../matcher";
import { normalize } from "../normalize";
import { loadPuzzle, publicQuestions, type PublicQuestion, type PuzzleQuestion } from "./puzzle";
import { matchPoints, ORDER_POINTS_PER_ITEM, scoreAnswer, type Tier } from "./scoring";
import { refreshPlayerStats } from "./stats";

/** Seconds per question (tune here). */
export const QUESTION_SECONDS = { free_text: 20, match: 40, order: 40 } as const;
/** Network slack after the deadline for answers already on their way. */
export const GRACE_MS = 2000;
const MAX_TEXT_LENGTH = 120;

export class GameError extends Error {
  constructor(public code: string, message: string, public httpStatus = 400) {
    super(message);
  }
}

type Db = Pool | PoolClient;

export interface NamedEntity {
  id: string;
  name: string;
}

/** A player's own answer: where known, its [lat, lon] so the client can fly the plane there. */
export type AnsweredEntity = NamedEntity & { partOf?: string; at?: [number, number] };

export interface PlayState {
  state: "not_started" | "playing" | "done";
  startedAt?: string;
  deadline?: string;
  seconds: number;
}

export interface GivenAnswer {
  entity: AnsweredEntity;
  status: "valid" | "real_but_wrong";
  points: number;
  tier?: Tier;
  share?: number;
}

export interface QuestionSummary {
  idx: number;
  points: number;
  answers: GivenAnswer[];
  commonAnswers?: NamedEntity[];
  rareAnswers?: NamedEntity[];
  /** fact card about the rarest valid answer given so far (QUESTIONS.md §4) */
  fact?: { name: string; text: string };
  /** matching rounds: pairs[leftPos] = rightPos; ordering rounds: the submitted order */
  pairs?: number[];
  order?: number[];
  correct?: boolean[];
  /** matching: right pos per left pos; ordering: display positions in the right order */
  solution?: number[];
  /** ordering: each item's value in display order, with the unit */
  values?: number[];
  unit?: string;
  /** set when this question completed the day */
  dayComplete?: { total: number };
}

export interface StartResult {
  question: PublicQuestion;
  play: PlayState;
  serverNow: string;
  /** answers already given (resuming after a reload) */
  answers: GivenAnswer[];
  /** set if the question is already over */
  summary?: QuestionSummary;
}

export interface AnswerResult {
  status: "valid" | "real_but_wrong" | "unrecognised" | "did_you_mean" | "duplicate";
  entity?: AnsweredEntity;
  suggestion?: NamedEntity;
  alternative?: NamedEntity;
  otherType?: string;
  points: number;
  tier?: Tier;
  share?: number;
  /** points so far on this question */
  questionPoints: number;
  /** a valid answer ends the question: its summary (and dayComplete) comes straight back */
  summary?: QuestionSummary;
}

interface PlayRow {
  started_at: Date;
  deadline: Date;
  ended_at: Date | null;
}

export const secondsFor = (q: PuzzleQuestion) => QUESTION_SECONDS[q.kind];
const isOver = (p: PlayRow, now: Date) =>
  p.ended_at !== null || now.getTime() > p.deadline.getTime() + GRACE_MS;

async function getQuestion(db: Pool, date: string, idx: number, today: string) {
  if (date !== today) {
    throw new GameError("not_today", "Only today's puzzle can be played", 409);
  }
  const puzzle = await loadPuzzle(db, date);
  const q = puzzle?.find((x) => x.idx === idx);
  if (!puzzle || !q) throw new GameError("no_question", "No such question", 404);
  return { puzzle, q };
}

async function getPlay(db: Db, playerId: string, q: PuzzleQuestion): Promise<PlayRow | null> {
  const { rows } = await db.query<PlayRow>(
    `SELECT started_at, deadline, ended_at FROM question_plays
     WHERE player_id = $1 AND date = $2 AND idx = $3`,
    [playerId, q.date, q.idx],
  );
  return rows[0] ?? null;
}

/** Every play of the player on this date, keyed by idx. */
export async function playsFor(db: Db, playerId: string, date: string): Promise<Map<number, PlayRow>> {
  const { rows } = await db.query<PlayRow & { idx: number }>(
    `SELECT idx, started_at, deadline, ended_at FROM question_plays WHERE player_id = $1 AND date = $2`,
    [playerId, date],
  );
  return new Map(rows.map((r) => [r.idx, r]));
}

export function playState(q: PuzzleQuestion, p: PlayRow | undefined | null, now: Date): PlayState {
  const seconds = secondsFor(q);
  if (!p) return { state: "not_started", seconds };
  return {
    state: isOver(p, now) ? "done" : "playing",
    startedAt: p.started_at.toISOString(), deadline: p.deadline.toISOString(), seconds,
  };
}

// ------------------------------------------------------------------ start

export async function startQuestion(db: Pool, input: {
  playerId: string; date: string; idx: number; today: string; now?: Date;
}): Promise<StartResult> {
  const now = input.now ?? new Date();
  const { puzzle, q } = await getQuestion(db, input.date, input.idx, input.today);
  await closeExpired(db, input.playerId, puzzle, input.today, now);
  const plays = await playsFor(db, input.playerId, q.date);
  let play = plays.get(q.idx) ?? null;
  if (!play) {
    const earlier = puzzle.filter((x) => x.idx < q.idx);
    if (earlier.some((x) => { const p = plays.get(x.idx); return !p || !isOver(p, now); })) {
      throw new GameError("out_of_order", "Finish the earlier questions first", 409);
    }
    await db.query(
      `INSERT INTO question_plays (player_id, date, idx, started_at, deadline)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
      [input.playerId, q.date, q.idx, now, new Date(now.getTime() + secondsFor(q) * 1000)],
    );
    play = await getPlay(db, input.playerId, q);
  }
  const state = playState(q, play, now);
  return {
    question: (await publicQuestions(db, [q]))[0],
    play: state,
    serverNow: now.toISOString(),
    answers: await givenAnswers(db, input.playerId, q),
    ...(state.state === "done" ? { summary: await summarize(db, input.playerId, q) } : {}),
  };
}

// ------------------------------------------------------------------ free text

export async function submitAnswer(db: Pool, input: {
  playerId: string; date: string; idx: number; text?: string; confirmEntityId?: string;
  pairs?: number[]; order?: number[]; today: string; now?: Date;
}): Promise<AnswerResult | QuestionSummary> {
  const now = input.now ?? new Date();
  const { puzzle, q } = await getQuestion(db, input.date, input.idx, input.today);
  const play = await getPlay(db, input.playerId, q);
  if (!play) throw new GameError("not_started", "Start the question first", 409);
  if (isOver(play, now)) throw new GameError("time_up", "Time's up for this question", 409);
  if (q.kind === "match") return submitMatch(db, input, q, puzzle, now);
  if (q.kind === "order") return submitOrder(db, input, q, puzzle, now);

  const raw = (input.text ?? "").slice(0, MAX_TEXT_LENGTH);
  if (!raw.trim()) throw new GameError("empty", "Type an answer");
  const m = await matchAnswer(db, raw, {
    entityType: q.entityType, validIds: q.validIds, confirmEntityId: input.confirmEntityId,
  });
  const questionPoints = () => pointsOn(db, input.playerId, q);

  if (m.status === "unrecognised") {
    const logged = normalize(raw) || raw.trim().toLowerCase();
    await db.query(
      `INSERT INTO unmatched_log (date, idx, raw_text, n) VALUES ($1, $2, $3, 1)
       ON CONFLICT (date, idx, raw_text) DO UPDATE SET n = unmatched_log.n + 1`,
      [q.date, q.idx, logged],
    );
    return { status: "unrecognised", points: 0, questionPoints: await questionPoints(),
             ...(m.otherType ? { otherType: m.otherType } : {}) };
  }
  // Corrections are suggested, never applied silently: only exact name/alias hits or a confirm
  // from the player get recorded.
  const corrected = m.status !== "did_you_mean" && m.method === "fuzzy" && !input.confirmEntityId;
  if (m.status === "did_you_mean" || corrected) {
    const s = m.status === "did_you_mean" ? m.suggestion! : m.entity!;
    return {
      status: "did_you_mean", points: 0, questionPoints: await questionPoints(),
      suggestion: { id: s.id, name: s.name },
      ...(m.alternative ? { alternative: { id: m.alternative.id, name: m.alternative.name } } : {}),
    };
  }

  const entity: AnsweredEntity = { id: m.entity!.id, name: m.entity!.name,
                   ...(m.entity!.partOf ? { partOf: m.entity!.partOf } : {}),
                   ...(m.entity!.at ? { at: m.entity!.at } : {}) };
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const ins = await client.query<{ id: string }>(
      `INSERT INTO answers (player_id, date, idx, raw_text, matched_entity_id, valid, points,
                            status, kind, detail)
       VALUES ($1, $2, $3, $4, $5, $6, 0, $7, 'free_text', $8)
       ON CONFLICT (player_id, date, idx, matched_entity_id) WHERE matched_entity_id IS NOT NULL
       DO NOTHING RETURNING id`,
      [input.playerId, q.date, q.idx, raw, entity.id, m.status === "valid", m.status,
       JSON.stringify(m.namesakes?.length ? { namesakes: m.namesakes.map((n) => n.id) } : {})],
    );
    if (!ins.rows.length) {
      await client.query("ROLLBACK");
      return { status: "duplicate", entity, points: 0, questionPoints: await questionPoints() };
    }
    const nSame = (await client.query<{ n: number }>(
      `INSERT INTO answer_counts (date, idx, entity_id, n) VALUES ($1, $2, $3, 1)
       ON CONFLICT (date, idx, entity_id) DO UPDATE SET n = answer_counts.n + 1 RETURNING n`,
      [q.date, q.idx, entity.id],
    )).rows[0].n;
    let points = 0;
    let tier: Tier | undefined;
    let share: number | undefined;
    if (m.status === "valid") {
      ({ points, tier, share } = scoreAnswer(nSame, await playersOn(client, q), q.prior.get(entity.id) ?? 0));
      await client.query(
        "UPDATE answers SET points = $1, tier = $2, share = $3 WHERE id = $4",
        [points, tier, share, ins.rows[0].id],
      );
    }
    // the first correct answer is final: it ends the question
    const dayComplete = m.status === "valid"
      ? await endPlay(client, input.playerId, q, puzzle, input.today, now)
      : await updateDailyScore(client, input.playerId, q.date, null);
    const total = await pointsOn(client, input.playerId, q);
    await client.query("COMMIT");
    const summary = m.status === "valid"
      ? { ...(await summarize(db, input.playerId, q)), ...(dayComplete ? { dayComplete } : {}) }
      : undefined;
    return { status: m.status, entity, points, tier, share, questionPoints: total,
             ...(summary ? { summary } : {}) };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    // two correct answers racing: the second loses to answers_one_valid
    if ((e as { constraint?: string }).constraint === "answers_one_valid") {
      throw new GameError("already_answered", "You've already answered this one", 409);
    }
    throw e;
  } finally {
    client.release();
  }
}

// ------------------------------------------------------------------ matching rounds

async function submitMatch(
  db: Pool, input: { playerId: string; pairs?: number[]; today: string },
  q: PuzzleQuestion, puzzle: PuzzleQuestion[], now: Date,
): Promise<QuestionSummary> {
  const n = q.pairs.length;
  const pairs = input.pairs;
  const picked = (pairs ?? []).filter((p) => p !== -1);
  if (!Array.isArray(pairs) || pairs.length !== n ||
      !pairs.every((p) => Number.isInteger(p) && p >= -1 && p < n) ||
      new Set(picked).size !== picked.length) {
    throw new GameError("bad_pairs", `Pair each of the ${n} items with a different option (-1 = none)`);
  }
  const correct = q.pairs.map((p, i) => pairs[i] >= 0 && q.rightOrder[pairs[i]] === p.right);
  const points = matchPoints(q.pairs.filter((_, i) => correct[i]));
  return recordRound(db, input.playerId, q, puzzle, input.today, now, points, correct.every(Boolean),
                     JSON.stringify(pairs), { pairs, correct });
}

async function submitOrder(
  db: Pool, input: { playerId: string; order?: number[]; today: string },
  q: PuzzleQuestion, puzzle: PuzzleQuestion[], now: Date,
): Promise<QuestionSummary> {
  const n = q.items.length;
  const order = input.order;
  if (!Array.isArray(order) || order.length !== n || new Set(order).size !== n ||
      !order.every((p) => Number.isInteger(p) && p >= 0 && p < n)) {
    throw new GameError("bad_order", `Send all ${n} items in your order`);
  }
  const correct = order.map((p, i) => q.answer[i] === p);
  const points = correct.filter(Boolean).length * ORDER_POINTS_PER_ITEM;
  return recordRound(db, input.playerId, q, puzzle, input.today, now, points, correct.every(Boolean),
                     JSON.stringify(order), { order, correct });
}

/** Store a matching/ordering submission and end the question. */
async function recordRound(
  db: Pool, playerId: string, q: PuzzleQuestion, puzzle: PuzzleQuestion[], today: string,
  now: Date, points: number, allRight: boolean, raw: string, detail: object,
): Promise<QuestionSummary> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO answers (player_id, date, idx, raw_text, valid, points, final_points, status,
                            kind, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $7, $8)
       ON CONFLICT (player_id, date, idx) WHERE kind IN ('match', 'order') DO NOTHING`,
      [playerId, q.date, q.idx, raw, allRight, points, q.kind, JSON.stringify(detail)],
    );
    const dayComplete = await endPlay(client, playerId, q, puzzle, today, now);
    await client.query("COMMIT");
    return { ...(await summarize(db, playerId, q)), ...(dayComplete ? { dayComplete } : {}) };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ------------------------------------------------------------------ end / summary

/** "I'm done" or time up: end the question (idempotent) and return its summary + reveal. */
export async function endQuestion(db: Pool, input: {
  playerId: string; date: string; idx: number; today: string; now?: Date;
}): Promise<QuestionSummary> {
  const now = input.now ?? new Date();
  const puzzle = await loadPuzzle(db, input.date);
  const q = puzzle?.find((x) => x.idx === input.idx);
  if (!puzzle || !q) throw new GameError("no_question", "No such question", 404);
  const play = await getPlay(db, input.playerId, q);
  if (!play) throw new GameError("not_started", "That question hasn't been started", 409);
  let dayComplete: { total: number } | null = null;
  if (play.ended_at === null) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      dayComplete = await endPlay(client, input.playerId, q, puzzle, input.today, now);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
  return { ...(await summarize(db, input.playerId, q)), ...(dayComplete ? { dayComplete } : {}) };
}

/** Close plays whose time ran out while the player was away (e.g. closed the tab). */
export async function closeExpired(
  db: Pool, playerId: string, puzzle: PuzzleQuestion[], today: string, now = new Date(),
): Promise<void> {
  const res = await db.query(
    `UPDATE question_plays SET ended_at = deadline
     WHERE player_id = $1 AND date = $2 AND ended_at IS NULL
       AND deadline + make_interval(secs => $3) < $4`,
    [playerId, puzzle[0].date, GRACE_MS / 1000, now],
  );
  if (res.rowCount) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await updateDailyScore(client, playerId, puzzle[0].date, puzzle, today);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
}

async function endPlay(
  client: PoolClient, playerId: string, q: PuzzleQuestion, puzzle: PuzzleQuestion[],
  today: string, now: Date,
): Promise<{ total: number } | null> {
  await client.query(
    `UPDATE question_plays SET ended_at = least($4::timestamptz, deadline)
     WHERE player_id = $1 AND date = $2 AND idx = $3 AND ended_at IS NULL`,
    [playerId, q.date, q.idx, now],
  );
  return updateDailyScore(client, playerId, q.date, puzzle, today);
}

/**
 * Keep daily_scores current. With `puzzle`, also check whether every question has ended; if so
 * mark the day finished and refresh player stats. Returns the day total when finished.
 */
async function updateDailyScore(
  client: PoolClient, playerId: string, date: string, puzzle: PuzzleQuestion[] | null,
  today?: string,
): Promise<{ total: number } | null> {
  const { rows } = await client.query<{ total: string; ended: string }>(
    `SELECT (SELECT coalesce(sum(points), 0) FROM answers WHERE player_id = $1 AND date = $2) AS total,
            (SELECT count(*) FROM question_plays WHERE player_id = $1 AND date = $2
               AND ended_at IS NOT NULL) AS ended`,
    [playerId, date],
  );
  const total = Number(rows[0].total);
  const done = puzzle !== null && Number(rows[0].ended) >= puzzle.length;
  await client.query(
    `INSERT INTO daily_scores (date, player_id, instant_points, finished) VALUES ($1, $2, $3, $4)
     ON CONFLICT (date, player_id) DO UPDATE SET instant_points = $3,
       finished = daily_scores.finished OR $4`,
    [date, playerId, total, done],
  );
  if (!done) return null;
  await refreshPlayerStats(client, playerId, today!);
  return { total };
}

async function pointsOn(db: Db, playerId: string, q: PuzzleQuestion): Promise<number> {
  return Number((await db.query<{ n: string }>(
    "SELECT coalesce(sum(points), 0) AS n FROM answers WHERE player_id = $1 AND date = $2 AND idx = $3",
    [playerId, q.date, q.idx],
  )).rows[0].n);
}

/**
 * Share denominator: players who have answered the question (right or wrong). Each player has
 * at most one valid answer, so a share is "the part of players who said this" (PLAN §6).
 */
export async function playersOn(db: Db, q: { date: string; idx: number }): Promise<number> {
  return Number((await db.query<{ n: string }>(
    "SELECT count(DISTINCT player_id) AS n FROM answers WHERE date = $1 AND idx = $2",
    [q.date, q.idx],
  )).rows[0].n);
}

async function givenAnswers(db: Db, playerId: string, q: PuzzleQuestion): Promise<GivenAnswer[]> {
  if (q.kind !== "free_text") return [];
  const { rows } = await db.query<{
    id: string; name: string; status: "valid" | "real_but_wrong"; points: number;
    tier: Tier | null; share: number | null; lat: number | null; lon: number | null;
  }>(
    `SELECT e.id, e.name, a.status, a.points, a.tier, a.share, e.lat, e.lon
     FROM answers a JOIN entities e ON e.id = a.matched_entity_id
     WHERE a.player_id = $1 AND a.date = $2 AND a.idx = $3 ORDER BY a.id`,
    [playerId, q.date, q.idx],
  );
  return rows.map((r) => ({
    entity: { id: r.id, name: r.name, ...(r.lat !== null && r.lon !== null ? { at: pinAt(r.lat, r.lon) } : {}) },
    status: r.status, points: r.points,
    ...(r.tier ? { tier: r.tier } : {}), ...(r.share !== null ? { share: r.share } : {}),
  }));
}

/** The reveal for an ended question. Never call before the question is over for the player. */
async function summarize(db: Db, playerId: string, q: PuzzleQuestion): Promise<QuestionSummary> {
  if (q.kind !== "free_text") {
    const { rows } = await db.query<{
      points: number; detail: { pairs?: number[]; order?: number[]; correct?: boolean[] };
    }>(
      "SELECT points, detail FROM answers WHERE player_id = $1 AND date = $2 AND idx = $3 AND kind = $4",
      [playerId, q.date, q.idx, q.kind],
    );
    const r = rows[0];
    const base = { idx: q.idx, points: r?.points ?? 0, answers: [],
                   ...(r ? { correct: r.detail.correct } : {}) };
    if (q.kind === "order") {
      return { ...base, ...(r ? { order: r.detail.order } : {}), solution: q.answer,
               values: q.items.map((it) => it.value), unit: q.unit };
    }
    return { ...base, ...(r ? { pairs: r.detail.pairs } : {}),
             solution: q.pairs.map((p) => q.rightOrder.indexOf(p.right)) };
  }
  const answers = await givenAnswers(db, playerId, q);
  const shown = await reveal(db, q);
  const fact = await factCard(db, q, shown.rareAnswers[0]?.id);
  return {
    idx: q.idx, points: answers.reduce((s, a) => s + a.points, 0), answers, ...shown,
    ...(fact ? { fact } : {}),
  };
}

/** Fact card for the rarest valid answer anyone has given (fallback: the rarest shown). */
async function factCard(db: Db, q: PuzzleQuestion, fallbackId?: string) {
  const { rows } = await db.query<{ name: string; text: string }>(
    `SELECT e.name, f.text FROM entity_facts f JOIN entities e ON e.id = f.entity_id
     LEFT JOIN answer_counts c ON c.date = $1 AND c.idx = $2 AND c.entity_id = f.entity_id
     WHERE f.context = 'general' AND f.entity_id = ANY($3)
       AND (c.n IS NOT NULL OR f.entity_id = $4)
     ORDER BY (c.n IS NULL), c.n, e.popularity NULLS FIRST LIMIT 1`,
    [q.date, q.idx, q.validIds, fallbackId ?? null],
  );
  return rows[0] ?? null;
}

/** A few of the most common and of the rarest valid answers. */
async function reveal(db: Db, q: PuzzleQuestion): Promise<{ commonAnswers: NamedEntity[]; rareAnswers: NamedEntity[] }> {
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
