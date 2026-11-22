/**
 * Admin tools (PLAN.md §8 Phase 6): review upcoming puzzles, replace a question, browse
 * unrecognised answers and add aliases. Access: ADMIN_TOKEN (cookie gr_admin, set via
 * /api/admin/login?token=...). Without ADMIN_TOKEN the admin is open in development only.
 */
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Pool } from "pg";
import { normalize } from "../normalize";
import { DISPLAY_VARIANTS, type Display, displayOf } from "./images";
import { clearPuzzleCache } from "./puzzle";

export const ADMIN_COOKIE = "gr_admin";

export function adminAllowed(cookieToken: string | undefined): boolean {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return process.env.NODE_ENV !== "production";
  return cookieToken === token;
}

export interface UpcomingQuestion {
  date: string; idx: number; kind: string; family: string; difficulty: number; text: string;
  nAnswers: number; sample: string[]; reviewed: boolean; played: Record<string, number> | null;
}

export async function upcoming(db: Pool, from: string, days: number): Promise<UpcomingQuestion[]> {
  const { rows } = await db.query<{
    date: string; idx: number; kind: string; family: string; difficulty: number;
    question_text: string; n: number; sample: string[]; reviewed: boolean; played: Record<string, number> | null;
  }>(
    `SELECT to_char(q.date, 'YYYY-MM-DD') AS date, q.idx, q.kind, q.family, q.difficulty,
            q.question_text, cardinality(q.valid_entity_ids) AS n, d.reviewed,
            q.stats->'played' AS played,
            ARRAY(SELECT e.name FROM entities e WHERE e.id = ANY(q.valid_entity_ids)
                  ORDER BY e.popularity DESC NULLS LAST LIMIT 6) AS sample
     FROM puzzle_questions q JOIN daily_puzzles d ON d.date = q.date
     WHERE q.date >= $1 AND q.date < $1::date + $2::int ORDER BY q.date, q.idx`,
    [from, days],
  );
  return rows.map((r) => ({
    date: r.date, idx: r.idx, kind: r.kind, family: r.family, difficulty: r.difficulty,
    text: r.question_text, nAnswers: r.n, sample: r.sample, reviewed: r.reviewed, played: r.played,
  }));
}

export interface UnmatchedRow { date: string; idx: number; question: string; entityType: string; raw: string; n: number }

export async function unmatched(db: Pool, limit = 100): Promise<UnmatchedRow[]> {
  const { rows } = await db.query<{
    date: string; idx: number; question_text: string; entity_type: string; raw_text: string; n: number;
  }>(
    `SELECT to_char(u.date, 'YYYY-MM-DD') AS date, u.idx, q.question_text, q.entity_type, u.raw_text, u.n
     FROM unmatched_log u JOIN puzzle_questions q ON q.date = u.date AND q.idx = u.idx
     ORDER BY u.n DESC, u.date DESC LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({ date: r.date, idx: r.idx, question: r.question_text,
    entityType: r.entity_type, raw: r.raw_text, n: r.n }));
}

export async function searchEntities(db: Pool, type: string, q: string) {
  const { rows } = await db.query<{ id: string; name: string; country: string | null; type: string }>(
    `SELECT e.id, e.name, c.name AS country, e.type FROM entities e LEFT JOIN entities c ON c.id = e.country_id
     WHERE ($1 = '' OR e.type = $1) AND (e.name ILIKE '%' || $2 || '%' OR similarity(e.name, $2) > 0.3)
     ORDER BY similarity(e.name, $2) DESC, e.popularity DESC NULLS LAST LIMIT 10`,
    [type, q],
  );
  return rows;
}

/** A manual alias survives pipeline reloads (load.py keeps kind = 'manual'). */
export async function addAlias(db: Pool, entityId: string, alias: string): Promise<string> {
  const { rows } = await db.query<{ type: string }>("SELECT type FROM entities WHERE id = $1", [entityId]);
  if (!rows[0]) throw new Error("no such entity");
  const norm = normalize(alias, rows[0].type);
  if (!norm) throw new Error("alias normalises to nothing");
  await db.query(
    `INSERT INTO aliases (entity_id, alias, alias_norm, kind) VALUES ($1, $2, $3, 'manual')
     ON CONFLICT DO NOTHING`,
    [entityId, alias.trim(), norm],
  );
  return norm;
}

export async function setReviewed(db: Pool, date: string, reviewed: boolean): Promise<void> {
  await db.query("UPDATE daily_puzzles SET reviewed = $2 WHERE date = $1", [date, reviewed]);
}

const run = promisify(execFile);

/**
 * Replace a question via the pipeline (geo_pipeline.replace_question). Runs it directly when the
 * pipeline is next to the app (local / admin box); otherwise returns the command to run.
 */
export async function replaceQuestion(date: string, idx: number): Promise<{ ok: boolean; message: string }> {
  const args = ["-m", "geo_pipeline.replace_question", "--date", date, "--idx", String(idx)];
  const command = `cd pipeline && python ${args.join(" ")}`;
  if (process.env.NODE_ENV === "production" && !process.env.ADMIN_RUN_PIPELINE) {
    return { ok: false, message: `Run on the pipeline machine: ${command}` };
  }
  try {
    const { stdout } = await run("python", args, { cwd: join(process.cwd(), "..", "pipeline"), timeout: 120_000 });
    clearPuzzleCache();
    return { ok: true, message: stdout.trim() };
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    return { ok: false, message: (err.stderr?.trim().split("\n").at(-1) ?? err.message) };
  }
}

// ------------------------------------------------------------------ writing questions by hand

/** Dates before today, or with any answers, are frozen (CLAUDE.md: past puzzles never change). */
export async function assertEditable(db: Pool, date: string, today: string): Promise<void> {
  if (date < today) throw new Error(`${date} is in the past; past puzzles are frozen`);
  const { rows } = await db.query("SELECT 1 FROM answers WHERE date = $1 LIMIT 1", [date]);
  if (rows.length) throw new Error(`${date} already has answers; it can't change`);
}

export const ENTITY_TYPES = [
  "country", "city", "region", "airport", "mountain", "river", "lake", "island", "landmark", "animal",
] as const;
export const CONTINENTS = ["Africa", "Asia", "Europe", "North America", "Oceania", "South America"];

export interface DayQuestionDetail {
  idx: number; kind: string; family: string; difficulty: number; text: string; templateId: string;
  entityType: string; custom: boolean;
  /** free text: every valid answer, most popular first */
  answers?: { id: string; name: string; country: string | null }[];
  pairs?: { left: string; leftLabel: string; rightLabel: string; category: string }[];
  decoys?: string[];
  items?: { label: string; value: number }[];
  unit?: string; direction?: string; display?: string;
}

/** Everything about one day, for the day editor. */
export async function dayDetail(db: Pool, date: string): Promise<{
  exists: boolean; reviewed: boolean; hasAnswers: boolean; questions: DayQuestionDetail[];
}> {
  const day = await db.query<{ reviewed: boolean }>("SELECT reviewed FROM daily_puzzles WHERE date = $1", [date]);
  const answered = await db.query("SELECT 1 FROM answers WHERE date = $1 LIMIT 1", [date]);
  const { rows } = await db.query<{
    idx: number; kind: string; family: string; difficulty: number; question_text: string;
    template_id: string; entity_type: string; valid_entity_ids: string[];
    payload: {
      variant?: string; pairs?: { left: string; left_label?: string; right_label: string; category: string }[];
      decoys?: { right: string; right_label: string }[];
      items?: { label: string; value: number }[]; unit?: string; direction?: string; answer?: number[];
    };
  }>(
    `SELECT idx, kind, family, difficulty, question_text, template_id, entity_type, valid_entity_ids,
            payload FROM puzzle_questions WHERE date = $1 ORDER BY idx`,
    [date],
  );
  const ids = rows.flatMap((r) => r.valid_entity_ids);
  const ents = new Map((await db.query<{ id: string; name: string; country: string | null; pop: number }>(
    `SELECT e.id, e.name, c.name AS country, coalesce(e.popularity, 0) AS pop
     FROM entities e LEFT JOIN entities c ON c.id = e.country_id WHERE e.id = ANY($1)`, [ids],
  )).rows.map((r) => [r.id, r]));
  const questions = rows.map((r): DayQuestionDetail => {
    const base = {
      idx: r.idx, kind: r.kind, family: r.family, difficulty: r.difficulty, text: r.question_text,
      templateId: r.template_id, entityType: r.entity_type, custom: r.template_id.startsWith("custom_"),
    };
    if (r.kind === "match") {
      return { ...base, display: displayOf(r.payload.variant),
        pairs: (r.payload.pairs ?? []).map((p) => ({
          left: p.left, leftLabel: p.left_label ?? ents.get(p.left)?.name ?? p.left,
          rightLabel: p.right_label, category: p.category,
        })),
        decoys: (r.payload.decoys ?? []).map((d) => d.right_label) };
    }
    if (r.kind === "order") {
      const items = r.payload.items ?? [];
      return { ...base, unit: r.payload.unit, direction: r.payload.direction,
        items: (r.payload.answer ?? []).map((pos) => ({ label: items[pos].label, value: items[pos].value })) };
    }
    return { ...base, answers: r.valid_entity_ids
      .map((id) => ents.get(id) ?? { id, name: id, country: null, pop: 0 })
      .sort((a, b) => b.pop - a.pop)
      .map(({ id, name, country }) => ({ id, name, country })) };
  });
  return { exists: !!day.rows[0], reviewed: day.rows[0]?.reviewed ?? false,
           hasAnswers: answered.rows.length > 0, questions };
}

/** Days from `from` for the calendar: how many questions each has and how many are custom. */
export async function calendar(db: Pool, from: string, days: number) {
  const { rows } = await db.query<{ date: string; n: number; custom: number; reviewed: boolean; answered: boolean }>(
    `SELECT to_char(d.date, 'YYYY-MM-DD') AS date, count(q.idx)::int AS n,
            count(q.idx) FILTER (WHERE q.template_id LIKE 'custom\\_%')::int AS custom,
            coalesce(p.reviewed, false) AS reviewed,
            EXISTS (SELECT 1 FROM answers a WHERE a.date = d.date) AS answered
     FROM generate_series($1::date, $1::date + ($2::int - 1), '1 day') AS d(date)
     LEFT JOIN daily_puzzles p ON p.date = d.date
     LEFT JOIN puzzle_questions q ON q.date = d.date
     GROUP BY d.date, p.reviewed ORDER BY d.date`,
    [from, days],
  );
  return rows;
}

/** Turn pasted lines into entities of `type` by exact name/alias (most popular wins). */
export async function resolveNames(db: Pool, type: string, lines: string[]) {
  const wanted = lines.map((l) => l.trim()).filter(Boolean).slice(0, 500);
  const norms = wanted.map((l) => normalize(l, type));
  const { rows } = await db.query<{ norm: string; id: string; name: string; country: string | null }>(
    `SELECT DISTINCT ON (a.alias_norm) a.alias_norm AS norm, e.id, e.name, c.name AS country
     FROM aliases a JOIN entities e ON e.id = a.entity_id LEFT JOIN entities c ON c.id = e.country_id
     WHERE e.type = $1 AND a.alias_norm = ANY($2)
     ORDER BY a.alias_norm, (a.kind = 'name') DESC, e.popularity DESC NULLS LAST`,
    [type, norms],
  );
  const byNorm = new Map(rows.map((r) => [r.norm, r]));
  const found: { id: string; name: string; country: string | null }[] = [];
  const missing: { text: string; suggestions: { id: string; name: string; country: string | null }[] }[] = [];
  for (let i = 0; i < wanted.length; i++) {
    const hit = byNorm.get(norms[i]);
    if (hit) found.push({ id: hit.id, name: hit.name, country: hit.country });
    else missing.push({ text: wanted[i], suggestions: (await searchEntities(db, type, wanted[i])).slice(0, 3) });
  }
  return { found, missing };
}

/** Every entity of a type in a continent or country (the "add all" button of the builder). */
export async function entitiesWhere(db: Pool, type: string, where: {
  continent?: string; countryId?: string; kind?: string;
}) {
  const { rows } = await db.query<{ id: string; name: string; country: string | null }>(
    `SELECT e.id, e.name, c.name AS country FROM entities e LEFT JOIN entities c ON c.id = e.country_id
     WHERE e.type = $1
       AND ($2::text IS NULL OR c.attrs->>'continent' = $2 OR (e.type = 'country' AND e.attrs->>'continent' = $2)
            OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(coalesce(e.attrs->'countries', '[]')) x
                       JOIN entities k ON k.id = x WHERE k.attrs->>'continent' = $2))
       AND ($3::text IS NULL OR e.country_id = $3 OR coalesce(e.attrs->'countries', '[]') ? $3)
       AND ($4::text IS NULL OR e.attrs->>'kind' = $4 OR ($4 = 'volcano' AND (e.attrs->>'volcano')::boolean))
     ORDER BY e.popularity DESC NULLS LAST LIMIT 3000`,
    [type, where.continent ?? null, where.countryId ?? null, where.kind ?? null],
  );
  return rows;
}

export interface CustomFreeText {
  kind: "free_text"; text: string; entityType: string; family: string; difficulty: number;
  answerIds: string[];
}
export interface CustomMatch {
  kind: "match"; text: string; difficulty: number; display: Display;
  pairs: { left: string; rightLabel: string; category: string }[];
  /** extra right-hand options that match nothing */
  decoys?: string[];
}
export interface CustomOrder {
  kind: "order"; text: string; difficulty: number; unit: string; direction: "asc" | "desc";
  items: { label: string; value: number; id?: string }[];
}
export type CustomQuestion = CustomFreeText | CustomMatch | CustomOrder;

const CATEGORIES = ["famous", "well_known", "familiar", "obscure", "rarest"];

function shuffled<T>(xs: T[]): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Shuffle until the display order isn't already the answer (never shown presorted). */
function displayOrder<T>(xs: T[], sorted: (ys: T[]) => boolean): T[] {
  for (let i = 0; i < 20; i++) {
    const s = shuffled(xs);
    if (!sorted(s)) return s;
  }
  return [...xs].reverse();
}

/**
 * Write a hand-made question into slot `idx` of `date` (creating the day if needed). The answer
 * set is frozen right here, exactly like generated ones.
 */
export async function saveCustom(db: Pool, date: string, idx: number, q: CustomQuestion, today: string) {
  await assertEditable(db, date, today);
  if (!Number.isInteger(idx) || idx < 0 || idx > 5) throw new Error("slot must be 1-6");
  const text = String(q.text ?? "").trim();
  if (text.length < 8) throw new Error("write the question text");
  const difficulty = [1, 2, 3].includes(q.difficulty) ? q.difficulty : 2;
  let row: [string, string[], string, string, string, object, object];
  if (q.kind === "free_text") {
    if (!(ENTITY_TYPES as readonly string[]).includes(q.entityType)) throw new Error("pick an answer type");
    const ids = [...new Set(q.answerIds)];
    const ok = (await db.query<{ id: string }>(
      "SELECT id FROM entities WHERE id = ANY($1) AND type = $2", [ids, q.entityType],
    )).rows.map((r) => r.id);
    if (ok.length < 3) throw new Error("a question needs at least 3 right answers");
    if (ok.length !== ids.length) throw new Error(`${ids.length - ok.length} answers aren't ${q.entityType}s`);
    row = ["custom_free_text", ok, q.family || "custom", q.entityType, "free_text",
           { n_answers: ok.length, author: "admin" }, {}];
  } else if (q.kind === "match") {
    const pairs = q.pairs ?? [];
    const n = pairs.length;
    if (n < 3 || n > 4) throw new Error("a matching round has 3 or 4 pairs");
    const labels = pairs.map((p) => p.rightLabel.trim());
    if (labels.some((l) => !l) || new Set(labels).size !== n) throw new Error(`${n} different right-hand labels`);
    const lefts = (await db.query<{ id: string; type: string }>(
      "SELECT id, type FROM entities WHERE id = ANY($1)", [pairs.map((p) => p.left)],
    )).rows;
    if (lefts.length !== n) throw new Error(`pick ${n} different left-hand items`);
    const decoys = (q.decoys ?? []).map((d) => String(d).trim()).filter(Boolean);
    if (decoys.length > 3) throw new Error("at most 3 options that match nothing");
    if (new Set([...labels, ...decoys].map((l) => l.toLowerCase())).size !== n + decoys.length) {
      throw new Error("every option on the right must be different");
    }
    if (q.display !== "names" && lefts.some((l) => l.type !== "country")) {
      throw new Error("flags and outlines need countries on the left");
    }
    const rights = pairs.map((_, i) => `custom:${i}`);
    const decoyIds = decoys.map((_, i) => `custom:d${i}`);
    const variant = q.display === "names" ? "custom_match" : DISPLAY_VARIANTS[q.display];
    row = ["custom_match", pairs.map((p) => p.left), "matching", lefts[0].type, "match",
      { n_pairs: n, author: "admin" },
      { variant, pairs: shuffled(pairs.map((p, i) => ({
          left: p.left, right: rights[i], right_label: labels[i],
          category: CATEGORIES.includes(p.category) ? p.category : "familiar",
        }))),
        decoys: decoys.map((d, i) => ({ right: decoyIds[i], right_label: d })),
        right_order: shuffled([...rights, ...decoyIds]) }];
  } else if (q.kind === "order") {
    const items = (q.items ?? []).map((it, i) => ({
      id: it.id || `custom:${i}`, label: String(it.label).trim(), value: Number(it.value),
    }));
    if (items.length < 3 || items.length > 6) throw new Error("an ordering round has 3-6 items");
    if (items.some((it) => !it.label || !Number.isFinite(it.value))) throw new Error("every item needs a label and a number");
    if (new Set(items.map((it) => it.value)).size !== items.length) throw new Error("values must all differ");
    const dir = q.direction === "asc" ? 1 : -1;
    const isSorted = (xs: typeof items) => xs.every((x, i) => i === 0 || dir * (x.value - xs[i - 1].value) > 0);
    const display = displayOrder(items, isSorted);
    const answer = [...display.keys()].sort((a, b) => dir * (display[a].value - display[b].value));
    row = ["custom_order", display.map((it) => it.id), "ordering", "custom", "order",
      { n_items: items.length, author: "admin" },
      { variant: "custom_order", direction: q.direction === "asc" ? "asc" : "desc",
        unit: String(q.unit ?? "").trim(), items: display, answer }];
  } else {
    throw new Error("unknown question kind");
  }
  const [templateId, ids, family, entityType, kind, stats, payload] = row;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO daily_puzzles (date) VALUES ($1) ON CONFLICT DO NOTHING", [date]);
    await client.query("DELETE FROM puzzle_questions WHERE date = $1 AND idx = $2", [date, idx]);
    await client.query(
      `INSERT INTO puzzle_questions (date, idx, template_id, params, question_text, valid_entity_ids,
         family, entity_type, difficulty, stats, kind, payload)
       VALUES ($1, $2, $3, '{}', $4, $5, $6, $7, $8, $9, $10, $11)`,
      [date, idx, templateId, text, ids, family, entityType, difficulty, JSON.stringify(stats), kind,
       JSON.stringify(payload)],
    );
    await client.query("UPDATE daily_puzzles SET reviewed = false WHERE date = $1", [date]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  clearPuzzleCache();
}

/** Fix the wording of a question without touching its answers. */
export async function editText(db: Pool, date: string, idx: number, text: string, today: string) {
  await assertEditable(db, date, today);
  if (text.trim().length < 8) throw new Error("question text is too short");
  const res = await db.query(
    "UPDATE puzzle_questions SET question_text = $3 WHERE date = $1 AND idx = $2", [date, idx, text.trim()],
  );
  if (!res.rowCount) throw new Error("no such question");
  clearPuzzleCache();
}

/** Remove one slot (a day can be left with gaps while it's being written). */
export async function clearSlot(db: Pool, date: string, idx: number, today: string) {
  await assertEditable(db, date, today);
  await db.query("DELETE FROM puzzle_questions WHERE date = $1 AND idx = $2", [date, idx]);
  clearPuzzleCache();
}

/**
 * Auto-fill a day with the generator (geo_pipeline.generate_puzzles), keeping any hand-written
 * questions already in it: they're put back over the generated ones afterwards.
 */
export async function generateDay(db: Pool, date: string, today: string): Promise<{ ok: boolean; message: string }> {
  await assertEditable(db, date, today);
  const args = ["-m", "geo_pipeline.generate_puzzles", "--from", date, "--days", "1", "--replace",
                "--salt", `admin-${Date.now()}`];
  if (process.env.NODE_ENV === "production" && !process.env.ADMIN_RUN_PIPELINE) {
    return { ok: false, message: `Run on the pipeline machine: cd pipeline && python ${args.join(" ")}` };
  }
  const kept = (await db.query("SELECT * FROM puzzle_questions WHERE date = $1 AND template_id LIKE 'custom\\_%'", [date])).rows;
  try {
    await run("python", args, { cwd: join(process.cwd(), "..", "pipeline"), timeout: 180_000 });
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    return { ok: false, message: (err.stderr?.trim().split("\n").at(-1) ?? err.message) };
  }
  for (const r of kept) {
    await db.query("DELETE FROM puzzle_questions WHERE date = $1 AND idx = $2", [date, r.idx]);
    await db.query(
      `INSERT INTO puzzle_questions (date, idx, template_id, params, question_text, valid_entity_ids,
         family, entity_type, difficulty, stats, kind, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [date, r.idx, r.template_id, r.params, r.question_text, r.valid_entity_ids, r.family,
       r.entity_type, r.difficulty, r.stats, r.kind, r.payload],
    );
  }
  clearPuzzleCache();
  return { ok: true, message: kept.length ? `generated; kept ${kept.length} hand-written` : "generated" };
}
