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
  const { rows } = await db.query<{ id: string; name: string; country: string | null }>(
    `SELECT e.id, e.name, c.name AS country FROM entities e LEFT JOIN entities c ON c.id = e.country_id
     WHERE e.type = $1 AND (e.name ILIKE '%' || $2 || '%' OR similarity(e.name, $2) > 0.3)
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
