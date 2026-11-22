/**
 * Practice mode (PLAN.md phase 7): endless questions from practice_questions, never scored and
 * never stored. The server stays stateless: each answer names the practice question id, is
 * checked against its frozen answer set, and nothing is written. Valid answer sets still never
 * leave the server; a few examples are revealed once the question is over, as in the daily game.
 *
 * Practice questions use the daily shapes with date = "practice" and idx = the practice id, so
 * the play and summary screens are shared.
 */
import type { Pool } from "pg";
import { matchAnswer } from "../matcher";
import { type AnswerResult, GameError, type NamedEntity, QUESTION_SECONDS, type QuestionSummary } from "./answer";
import { type PublicQuestion, publicQuestions, type PuzzleQuestion, type QuestionRow, toQuestions } from "./puzzle";
import { MATCH_PAIR_POINTS, ORDER_POINTS_PER_ITEM, type Tier, TIERS } from "./scoring";

export const PRACTICE = "practice";
export type PracticeKind = "free_text" | "match" | "order";

const cache = new Map<number, { q: PuzzleQuestion; rarity: Record<string, string> }>();

export async function loadPractice(db: Pool, id: number): Promise<{ q: PuzzleQuestion; rarity: Record<string, string> }> {
  const hit = cache.get(id);
  if (hit) return hit;
  if (!Number.isInteger(id) || id < 1) throw new GameError("not_found", "No such practice question", 404);
  const { rows } = await db.query<QuestionRow>(
    `SELECT id AS idx, kind, question_text, family, entity_type, difficulty, template_id,
            valid_entity_ids, payload
     FROM practice_questions WHERE id = $1`,
    [id],
  );
  if (!rows.length) throw new GameError("not_found", "No such practice question", 404);
  const [q] = await toQuestions(db, PRACTICE, rows);
  const out = { q, rarity: rows[0].payload.answer_rarity ?? {} };
  if (cache.size > 2000) cache.clear();
  cache.set(id, out);
  return out;
}

/** A random practice question, not one of `seen` (the ids played this session). */
export async function nextPractice(
  db: Pool, kind: PracticeKind | null, seen: number[],
): Promise<{ question: PublicQuestion; seconds: number; difficulty: number } | null> {
  const pick = async (avoid: number[]) => (await db.query<{ id: number }>(
    `SELECT id FROM practice_questions
     WHERE ($1::text IS NULL OR kind = $1) AND NOT (id = ANY($2::int[]))
     ORDER BY random() LIMIT 1`,
    [kind, avoid],
  )).rows[0]?.id;
  // everything seen: start over
  const id = (await pick(seen)) ?? (await pick([]));
  if (!id) return null;
  const { q } = await loadPractice(db, id);
  const [question] = await publicQuestions(db, [q]);
  return { question, seconds: QUESTION_SECONDS[q.kind], difficulty: q.difficulty };
}

const tierPoints = (tier: Tier) => TIERS.find((t) => t.tier === tier)?.points ?? 0;

/** Common and rare examples by popularity (practice has no other players to count). */
async function examples(db: Pool, q: PuzzleQuestion): Promise<{ commonAnswers: NamedEntity[]; rareAnswers: NamedEntity[]; fact?: { name: string; text: string } }> {
  const byPrior = [...q.validIds].sort((a, b) => (q.prior.get(b) ?? 0) - (q.prior.get(a) ?? 0));
  const common = byPrior.slice(0, 3);
  const rare = [...byPrior].reverse().filter((id) => !common.includes(id)).slice(0, 3);
  const names = new Map((await db.query<{ id: string; name: string }>(
    "SELECT id, name FROM entities WHERE id = ANY($1)", [[...common, ...rare]],
  )).rows.map((r) => [r.id, r.name]));
  const named = (ids: string[]) => ids.map((id) => ({ id, name: names.get(id) ?? id }));
  const fact = (await db.query<{ name: string; text: string }>(
    `SELECT e.name, f.text FROM entity_facts f JOIN entities e ON e.id = f.entity_id
     WHERE f.context = 'general' AND f.entity_id = $1`, [rare[0] ?? null],
  )).rows[0];
  return { commonAnswers: named(common), rareAnswers: named(rare), ...(fact ? { fact } : {}) };
}

/** Time's up or skipped: the reveal with no answer. */
export async function revealPractice(db: Pool, id: number): Promise<QuestionSummary> {
  const { q } = await loadPractice(db, id);
  if (q.kind === "free_text") return { idx: q.idx, points: 0, answers: [], ...(await examples(db, q)) };
  if (q.kind === "order") {
    return { idx: q.idx, points: 0, answers: [], solution: q.answer,
             values: q.items.map((it) => it.value), unit: q.unit };
  }
  return { idx: q.idx, points: 0, answers: [], solution: q.pairs.map((p) => q.rightOrder.indexOf(p.right)) };
}

export async function answerPractice(db: Pool, input: {
  idx: number; text?: string; confirmEntityId?: string; pairs?: number[]; order?: number[];
}): Promise<AnswerResult | QuestionSummary> {
  const { q, rarity } = await loadPractice(db, input.idx);
  if (q.kind === "match") {
    const pairs = input.pairs;
    const picked = (pairs ?? []).filter((p) => p !== -1);
    if (!Array.isArray(pairs) || pairs.length !== q.pairs.length ||
        !pairs.every((p) => Number.isInteger(p) && p >= -1 && p < q.rightOrder.length) ||
        new Set(picked).size !== picked.length) {
      throw new GameError("bad_pairs", "Pair each item with a different option");
    }
    const correct = q.pairs.map((p, i) => pairs[i] >= 0 && q.rightOrder[pairs[i]] === p.right);
    const points = q.pairs.reduce((s, p, i) => s + (correct[i] ? MATCH_PAIR_POINTS[p.category] : 0), 0);
    return { ...(await revealPractice(db, q.idx)), points, pairs, correct };
  }
  if (q.kind === "order") {
    const order = input.order;
    const n = q.items.length;
    if (!Array.isArray(order) || order.length !== n || new Set(order).size !== n ||
        !order.every((p) => Number.isInteger(p) && p >= 0 && p < n)) {
      throw new GameError("bad_order", `Send all ${n} items in your order`);
    }
    const correct = order.map((p, i) => q.answer[i] === p);
    return { ...(await revealPractice(db, q.idx)), points: correct.filter(Boolean).length * ORDER_POINTS_PER_ITEM,
             order, correct };
  }

  const raw = (input.text ?? "").slice(0, 100);
  if (!raw.trim()) throw new GameError("empty", "Type an answer");
  const m = await matchAnswer(db, raw, { entityType: q.entityType, validIds: q.validIds,
                                         confirmEntityId: input.confirmEntityId });
  if (m.status === "unrecognised") {
    return { status: "unrecognised", points: 0, questionPoints: 0, ...(m.otherType ? { otherType: m.otherType } : {}) };
  }
  if (m.status === "did_you_mean" || (m.method === "fuzzy" && !input.confirmEntityId)) {
    const s = m.status === "did_you_mean" ? m.suggestion! : m.entity!;
    return { status: "did_you_mean", points: 0, questionPoints: 0, suggestion: { id: s.id, name: s.name },
             ...(m.alternative ? { alternative: { id: m.alternative.id, name: m.alternative.name } } : {}) };
  }
  const e = m.entity!;
  const entity = { id: e.id, name: e.name, ...(e.partOf ? { partOf: e.partOf } : {}),
                   ...(e.territoryOf ? { territoryOf: e.territoryOf } : {}), ...(e.at ? { at: e.at } : {}) };
  if (m.status !== "valid") return { status: "real_but_wrong", entity, points: 0, questionPoints: 0 };
  // rated by how well known the answer is (the rarity category computed with the question)
  const tier = (rarity[e.id] ?? "familiar") as Tier;
  const points = tierPoints(tier);
  const given = { entity, status: "valid" as const, points, tier };
  return {
    status: "valid", entity, points, tier, questionPoints: points,
    summary: { idx: q.idx, points, answers: [given], ...(await examples(db, q)) },
  };
}

