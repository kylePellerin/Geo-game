/**
 * Loading puzzles. Two views:
 *  - PuzzleQuestion (server only): frozen valid set, priors, matching pairs.
 *  - PublicQuestion (sent to clients): question text and, for matching rounds, the items in
 *    display order. Valid sets and the correct pairing never leave the server; flag images are
 *    referenced by position (/api/image/<date>/<idx>/<pos>), never by country.
 */
import type { Pool } from "pg";
import { type ImageKind, imageKind } from "./images";
import { priorShares } from "./scoring";

export interface MatchPair {
  left: string;
  right: string;
  right_label: string;
  /** hand-written rounds may label the left side themselves */
  left_label?: string;
  category: "famous" | "well_known" | "familiar" | "obscure" | "rarest";
}

export type QuestionKind = "free_text" | "match" | "order";

/** An ordering-round item (display order). value is secret until the question ends. */
export interface OrderItem {
  id: string;
  label: string;
  value: number;
}

export interface PuzzleQuestion {
  date: string;
  idx: number;
  kind: QuestionKind;
  text: string;
  family: string;
  entityType: string;
  difficulty: number;
  templateId: string;
  validIds: string[];
  /** free text: prior share per valid entity (cold-start scoring) */
  prior: Map<string, number>;
  /** match: pairs in left display order, right ids in right display order */
  pairs: MatchPair[];
  rightOrder: string[];
  variant?: string;
  /** free text over countries: dependent territories are valid answers too */
  territories: boolean;
  /** order: items in display order, the correct order (display positions), unit */
  items: OrderItem[];
  answer: number[];
  unit: string;
  direction: "asc" | "desc";
}

export interface PublicQuestion {
  idx: number;
  kind: QuestionKind;
  text: string;
  family: string;
  answerType: string;
  hint?: string;
  left?: { pos: number; label?: string; image?: string; picture?: ImageKind }[];
  right?: { pos: number; label: string }[];
  /** order: labels in display order */
  items?: { pos: number; label: string }[];
}

export const FAMILY_LABELS: Record<string, string> = {
  flags: "Flags", countries: "Countries", cities: "Cities", names: "Names", borders: "Borders",
  map_surprises: "Map surprises", airports: "Airports", nature: "Nature", olympics: "Olympics",
  matching: "Matching", ordering: "Ordering", mountains: "Mountains", water: "Rivers & lakes",
  islands: "Islands", landmarks: "Landmarks", regions: "Regions", symbols: "National symbols",
};

export function utcToday(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

const cache = new Map<string, PuzzleQuestion[]>();

export function clearPuzzleCache(): void {
  cache.clear();
}

/** All questions for a date (cached: puzzles are frozen once generated). */
export async function loadPuzzle(db: Pool, date: string): Promise<PuzzleQuestion[] | null> {
  const hit = cache.get(date);
  if (hit) return hit;
  const { rows } = await db.query<{
    idx: number; kind: QuestionKind; question_text: string; family: string;
    entity_type: string; difficulty: number; template_id: string; valid_entity_ids: string[];
    payload: {
      variant?: string; pairs?: MatchPair[]; right_order?: string[]; items?: OrderItem[];
      answer?: number[]; unit?: string; direction?: "asc" | "desc"; territories?: boolean;
    };
  }>(
    `SELECT idx, kind, question_text, family, entity_type, difficulty, template_id,
            valid_entity_ids, payload
     FROM puzzle_questions WHERE date = $1 ORDER BY idx`,
    [date],
  );
  if (!rows.length) return null;
  const freeIds = rows.filter((r) => r.kind === "free_text").flatMap((r) => r.valid_entity_ids);
  const pops = await db.query<{ id: string; popularity: number | null }>(
    "SELECT id, popularity FROM entities WHERE id = ANY($1)",
    [freeIds],
  );
  const popOf = new Map(pops.rows.map((r) => [r.id, r.popularity ?? 0]));
  const questions = rows.map((r): PuzzleQuestion => ({
    date,
    idx: r.idx,
    kind: r.kind,
    text: r.question_text,
    family: r.family,
    entityType: r.entity_type,
    difficulty: r.difficulty,
    templateId: r.template_id,
    validIds: r.valid_entity_ids,
    prior: r.kind === "free_text"
      ? priorShares(new Map(r.valid_entity_ids.map((id) => [id, popOf.get(id) ?? 0])))
      : new Map(),
    pairs: r.payload.pairs ?? [],
    rightOrder: r.payload.right_order ?? [],
    variant: r.payload.variant,
    territories: Boolean(r.payload.territories),
    items: r.payload.items ?? [],
    answer: r.payload.answer ?? [],
    unit: r.payload.unit ?? "",
    direction: r.payload.direction ?? "desc",
  }));
  cache.set(date, questions);
  return questions;
}

export async function publicQuestions(db: Pool, puzzle: PuzzleQuestion[]): Promise<PublicQuestion[]> {
  const leftIds = puzzle.filter((q) => q.kind === "match").flatMap((q) => q.pairs.map((p) => p.left));
  const names = new Map(
    (await db.query<{ id: string; name: string }>(
      "SELECT id, name FROM entities WHERE id = ANY($1)", [leftIds],
    )).rows.map((r) => [r.id, r.name]),
  );
  return puzzle.map((q) => {
    const base = {
      idx: q.idx, kind: q.kind, text: q.text,
      family: FAMILY_LABELS[q.family] ?? q.family, answerType: q.entityType,
      ...(q.territories ? { hint: "Territories (like Puerto Rico) count too" } : {}),
    };
    if (q.kind === "order") return { ...base, items: q.items.map((it, pos) => ({ pos, label: it.label })) };
    if (q.kind !== "match") return base;
    const labelOf = new Map(q.pairs.map((p) => [p.right, p.right_label]));
    const picture = imageKind(q.variant);
    return {
      ...base,
      left: q.pairs.map((p, pos) => picture
        ? { pos, image: `/api/image/${q.date}/${q.idx}/${pos}`, picture }
        : { pos, label: p.left_label ?? names.get(p.left) ?? p.left }),
      right: q.rightOrder.map((r, pos) => ({ pos, label: labelOf.get(r) ?? r })),
    };
  });
}
