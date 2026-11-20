/**
 * Answer matching (PLAN.md §5). Type-agnostic: works for any entity type with aliases.
 *
 *  1. normalise the input exactly like aliases were normalised at load time
 *  2. exact alias lookup restricted to the question's entity type
 *  3. otherwise fuzzy: pg_trgm candidates, then Damerau-Levenshtein (optimal string alignment)
 *     - <= 4 characters: exact only (codes like JFK, LAX)
 *     - 5-7 characters: edit distance <= 1
 *     - 8+ characters:  edit distance <= 2; trigram similarity >= 0.6 only suggests
 *  4. decide: one clear winner -> match; close/tied/similarity-only -> "did you mean";
 *     nothing -> unrecognised (with a hint if it's an exact name of another type)
 *     An exact hit on an obscure namesake of a far more famous place one edit away also asks
 *     ("Edinburg" -> "Did you mean Edinburgh?", with the Texas town as the alternative).
 *  5. validity: only now is the valid set consulted. If the matched name belongs to several
 *     entities (Springfield, St Petersburg), the answer is valid if any of them is valid.
 *
 * Matching runs against ALL entities of the type, never only the valid set, so a typo of a wrong
 * answer can't snap to a right one and players can't fish for answers.
 */
import type { Pool } from "pg";
import { normalize, TYPE_AFFIXES } from "./normalize";

export type MatchStatus = "valid" | "real_but_wrong" | "did_you_mean" | "unrecognised";

export interface MatchedEntity {
  id: string;
  name: string;
  type: string;
  /** set when the entity is a district of another city (Brooklyn -> New York City) */
  partOf?: string;
}

export interface MatchResult {
  status: MatchStatus;
  normalized: string;
  method?: "exact" | "fuzzy";
  entity?: MatchedEntity;
  /** for did_you_mean: the suggested entity (also in `entity`) */
  suggestion?: MatchedEntity;
  /** for did_you_mean on an exact hit: the obscure entity the player may really have meant */
  alternative?: MatchedEntity;
  distance?: number;
  /** other entities with exactly the same name (namesakes) */
  namesakes?: MatchedEntity[];
  /** unrecognised, but an exact name of another type ("Paris" asked for a country) */
  otherType?: string;
}

export interface MatchOptions {
  entityType: string;
  validIds: Iterable<string>;
  /** entity ids the player confirmed from an earlier "did you mean" */
  confirmEntityId?: string;
}

const FUZZY_CANDIDATES = 80;
const SUGGEST_SIMILARITY = 0.6;
/** Trigram similarity floor for candidates: short words share few trigrams ("isreal"/"israel"). */
const trigramFloor = (len: number) => (len <= 8 ? 0.2 : 0.3);
/**
 * An exact hit on an obscure place that is far less popular (log10 pageview units) than a place
 * one edit away gets a "did you mean" ("Edinburg" Texas vs Edinburgh). Never uses the valid set.
 */
const SHADOW_POPULARITY_GAP = 1.0;

/** Max edit distance auto-accepted for a normalised input of this length (0 = exact only). */
export function maxEdits(length: number): number {
  if (length <= 4) return 0;
  if (length <= 7) return 1;
  return 2;
}

/** Damerau-Levenshtein, optimal string alignment variant (adjacent transpositions = 1). */
export function editDistance(a: string, b: string): number {
  const s = Array.from(a);
  const t = Array.from(b);
  const d: number[][] = Array.from({ length: s.length + 1 }, (_, i) =>
    Array.from({ length: t.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= s.length; i++) {
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[s.length][t.length];
}

interface Row {
  id: string;
  name: string;
  type: string;
  popularity: number | null;
  part_of: string | null;
}

const ENTITY_COLS = `e.id, e.name, e.type, e.popularity, e.attrs->>'part_of_city' AS part_of`;

const sameName = (a: Row, b: Row) => normalize(a.name) === normalize(b.name);

function toEntity(r: Row): MatchedEntity {
  return { id: r.id, name: r.name, type: r.type, ...(r.part_of ? { partOf: r.part_of } : {}) };
}

/** Pick the entity to report from a namesake group: a valid one if any, else the most popular. */
function choose(rows: Row[], valid: Set<string>): { pick: Row; isValid: boolean } {
  const byPop = [...rows].sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0));
  const v = byPop.find((r) => valid.has(r.id));
  return { pick: v ?? byPop[0], isValid: Boolean(v) };
}

function verdict(
  normalized: string,
  method: "exact" | "fuzzy",
  rows: Row[],
  valid: Set<string>,
  distance?: number,
): MatchResult {
  const { pick, isValid } = choose(rows, valid);
  const namesakes = rows.filter((r) => r.id !== pick.id).map(toEntity);
  return {
    status: isValid ? "valid" : "real_but_wrong",
    normalized,
    method,
    entity: toEntity(pick),
    ...(distance !== undefined ? { distance } : {}),
    ...(namesakes.length ? { namesakes } : {}),
  };
}

export async function matchAnswer(db: Pool, raw: string, opts: MatchOptions): Promise<MatchResult> {
  const valid = new Set(opts.validIds);
  const type = opts.entityType;
  const q = normalize(raw, type);
  if (!q) return { status: "unrecognised", normalized: q };

  // A confirmed "did you mean": accept the entity only if it really is a close match.
  if (opts.confirmEntityId) {
    const { rows } = await db.query<Row & { alias_norm: string }>(
      `SELECT ${ENTITY_COLS}, a.alias_norm FROM aliases a JOIN entities e ON e.id = a.entity_id
       WHERE e.id = $1 AND e.type = $2`,
      [opts.confirmEntityId, type],
    );
    const close = rows.some(
      (r) => editDistance(q, r.alias_norm) <= Math.max(2, maxEdits(q.length)) ||
        r.alias_norm.startsWith(q) || q.startsWith(r.alias_norm),
    );
    if (rows.length && close) return verdict(q, "fuzzy", [rows[0]], valid);
  }

  // 2. exact alias lookup within the type
  const exactRows = await db.query<Row>(
    `SELECT DISTINCT ${ENTITY_COLS} FROM aliases a JOIN entities e ON e.id = a.entity_id
     WHERE a.alias_norm = $1 AND e.type = $2`,
    [q, type],
  );
  const exact = { rows: exactRows.rows };

  // 3. fuzzy candidates (also used to spot an exact hit shadowing a far more famous place)
  const limit = maxEdits(q.length);
  if (exact.rows.length) {
    if (limit > 0) {
      const ranked = await fuzzyCandidates(db, q, type);
      const exactPop = Math.max(...exact.rows.map((r) => r.popularity ?? 0));
      // shadowed: an obscure exact hit next to a far more famous place
      const famous = ranked.find((c) => c.dist === 1 && !exact.rows.some((r) => r.id === c.row.id) &&
        (c.row.popularity ?? 0) - exactPop >= SHADOW_POPULARITY_GAP);
      if (famous) {
        const { pick } = choose(exact.rows, valid);
        return {
          status: "did_you_mean", normalized: q, method: "fuzzy", entity: toEntity(famous.row),
          suggestion: toEntity(famous.row), alternative: toEntity(pick), distance: 1,
        };
      }
    }
    return verdict(q, "exact", exact.rows, valid);
  }

  // The input is exactly the name of something of another type ("France" for a city question):
  // say so instead of snapping to a lookalike (Franca, Brazil).
  // ...unless a more popular place of the right type is within reach ("Columbia" asked for a
  // country is Colombia, not Columbia SC).
  const hint = await otherTypeHint(db, q, type);
  if (limit === 0) return { status: "unrecognised", normalized: q, ...(hint ? { otherType: hint.type } : {}) };
  const ranked = await fuzzyCandidates(db, q, type);
  if (hint && !(ranked[0] && ranked[0].dist <= limit &&
                (ranked[0].row.popularity ?? 0) > hint.popularity)) {
    return { status: "unrecognised", normalized: q, otherType: hint.type };
  }
  // A misspelt type word ("Heathrow Aiport"): strip a leading/trailing word within one edit of an
  // affix word and try again.
  if (!ranked.length || ranked[0].dist > limit) {
    const stripped = stripFuzzyAffix(q, type);
    if (stripped !== q) {
      const retry = await matchAnswer(db, stripped, { ...opts, entityType: type });
      // the affix itself was misspelt: that's a correction, so never "exact"
      if (retry.status !== "unrecognised") {
        return { ...retry, normalized: q, ...(retry.method ? { method: "fuzzy" as const } : {}) };
      }
    }
  }
  if (!ranked.length) return { status: "unrecognised", normalized: q };
  const top = ranked[0];
  const withinEdits = top.dist <= limit;
  if (!withinEdits && top.sim < SUGGEST_SIMILARITY) return { status: "unrecognised", normalized: q };

  // namesakes: same matched alias or same display name as the top candidate (Amsterdam NL/NY)
  const group = ranked.filter((c) => c.alias === top.alias || sameName(c.row, top.row));
  // A differently-named place at the same distance is an ambiguity (Nigera: Niger or Nigeria?)
  // and gets a question, unless one place is far more famous than every rival (Shangai ->
  // Shanghai). Popularity only, never the valid set, so this can't be used to fish for answers.
  const rivals = ranked.filter((c) => !group.includes(c) && c.dist <= top.dist);
  if (withinEdits && rivals.length === 0) {
    return verdict(q, "fuzzy", group.filter((c) => c.dist === top.dist).map((c) => c.row),
      valid, top.dist);
  }
  if (withinEdits) {
    const tied = [top, ...rivals].filter((c) => c.dist === top.dist);
    const famous = tied.reduce((a, b) => ((b.row.popularity ?? 0) > (a.row.popularity ?? 0) ? b : a));
    const famousGroup = tied.filter((c) => c.alias === famous.alias || sameName(c.row, famous.row));
    const others = tied.filter((c) => !famousGroup.includes(c));
    if (others.every((c) => (famous.row.popularity ?? 0) - (c.row.popularity ?? 0) >= SHADOW_POPULARITY_GAP)) {
      return verdict(q, "fuzzy", famousGroup.map((c) => c.row), valid, famous.dist);
    }
  }
  // Tie with a differently-named entity, or similarity-only: ask, never decide for the player.
  // The suggestion ignores the valid set (most popular wins), so it can't leak answers.
  const suggestion = [top, ...rivals].sort(
    (a, b) => a.dist - b.dist || (b.row.popularity ?? 0) - (a.row.popularity ?? 0),
  )[0];
  return {
    status: "did_you_mean",
    normalized: q,
    method: "fuzzy",
    entity: toEntity(suggestion.row),
    suggestion: toEntity(suggestion.row),
    distance: suggestion.dist,
  };
}

interface Candidate {
  row: Row;
  alias: string;
  dist: number;
  sim: number;
}

/** Trigram candidates, best (distance, similarity) per entity, best first. */
async function fuzzyCandidates(db: Pool, q: string, type: string): Promise<Candidate[]> {
  const client = await db.connect();
  let rows: (Row & { alias_norm: string; sim: number })[];
  try {
    // `%` uses the session threshold; set it for this query so the trigram index is used
    await client.query("SELECT set_limit($1)", [trigramFloor(q.length)]);
    ({ rows } = await client.query<Row & { alias_norm: string; sim: number }>(
      `SELECT ${ENTITY_COLS}, a.alias_norm, similarity(a.alias_norm, $1) AS sim
       FROM aliases a JOIN entities e ON e.id = a.entity_id
       WHERE e.type = $2 AND a.alias_norm % $1
       ORDER BY sim DESC LIMIT $3`,
      [q, type, FUZZY_CANDIDATES],
    ));
  } finally {
    client.release();
  }
  // Swapped letters in short words share few trigrams ("lodnon"/"london"): also consider
  // aliases with the same first letter and a similar length, by edit distance alone.
  if (q.length <= 10) {
    const extra = await db.query<Row & { alias_norm: string; sim: number }>(
      `SELECT ${ENTITY_COLS}, a.alias_norm, similarity(a.alias_norm, $1) AS sim
       FROM aliases a JOIN entities e ON e.id = a.entity_id
       WHERE e.type = $2 AND a.alias_norm >= $3 AND a.alias_norm < $4
         AND length(a.alias_norm) BETWEEN $5 AND $6
       ORDER BY e.popularity DESC NULLS LAST LIMIT 5000`,
      [q, type, q[0], String.fromCodePoint(q.codePointAt(0)! + 1), q.length - 1, q.length + 1],
    );
    rows = rows.concat(extra.rows.filter((r) => editDistance(q, r.alias_norm) <= maxEdits(q.length)));
  }
  const best = new Map<string, Candidate>();
  for (const r of rows) {
    const dist = editDistance(q, r.alias_norm);
    const sim = Number(r.sim);
    const cur = best.get(r.id);
    if (!cur || dist < cur.dist || (dist === cur.dist && sim > cur.sim)) {
      best.set(r.id, { row: r, alias: r.alias_norm, dist, sim });
    }
  }
  return [...best.values()].sort(
    (a, b) => a.dist - b.dist || b.sim - a.sim || (b.row.popularity ?? 0) - (a.row.popularity ?? 0),
  );
}

/** Drop a first/last word that is a misspelt type word ("aiport", "intenational"). */
export function stripFuzzyAffix(q: string, type: string): string {
  const words = (TYPE_AFFIXES[type] ?? []).flatMap((a) => a.split(" ")).filter((w) => w.length >= 5);
  if (!words.length) return q;
  const parts = q.split(" ");
  if (parts.length < 2) return q;
  const near = (w: string) => words.some((a) => editDistance(w, a) <= 1);
  if (near(parts[parts.length - 1])) return parts.slice(0, -1).join(" ");
  if (near(parts[0])) return parts.slice(1).join(" ");
  return q;
}

async function otherTypeHint(
  db: Pool, q: string, type: string,
): Promise<{ type: string; popularity: number } | undefined> {
  const other = await db.query<{ type: string; popularity: number }>(
    `SELECT e.type, max(coalesce(e.popularity, 0)) AS popularity
     FROM aliases a JOIN entities e ON e.id = a.entity_id
     WHERE a.alias_norm = $1 AND e.type <> $2
     GROUP BY e.type ORDER BY 2 DESC LIMIT 1`,
    [q, type],
  );
  return other.rows[0] ? { type: other.rows[0].type, popularity: Number(other.rows[0].popularity) } : undefined;
}
