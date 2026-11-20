import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { closePool, getPool } from "./db";
import { editDistance, matchAnswer, maxEdits, type MatchResult } from "./matcher";
import { normalize } from "./normalize";

// ---------------------------------------------------------------- unit tests (no database)

describe("editDistance (optimal string alignment)", () => {
  it.each([
    ["kathmandu", "kathmandu", 0],
    ["kathmandoo", "kathmandu", 2],
    ["denmakr", "denmark", 1], // adjacent transposition counts once
    ["isreal", "israel", 1],
    ["", "abc", 3],
    ["ελλαδα", "ελλαδ", 1],
  ])("%s vs %s = %i", (a, b, d) => expect(editDistance(a, b)).toBe(d));
});

describe("maxEdits by length", () => {
  it.each([[3, 0], [4, 0], [5, 1], [7, 1], [8, 2], [20, 2]])("%i chars -> %i", (n, e) =>
    expect(maxEdits(n)).toBe(e));
});

// ---------------------------------------------------------------- fixtures (needs the DB)

type Case = {
  in: string;
  type: string;
  expect?: string;
  valid?: string[];
  status?: string | string[];
  wrong?: boolean;
  other_type?: string;
  note?: string;
};

const CASES: Case[] = parse(
  readFileSync(join(__dirname, "../../pipeline/tests/match_cases.yaml"), "utf8"),
);

let db: Pool | null = null;

beforeAll(async () => {
  try {
    const pool = getPool();
    await pool.query("SELECT 1");
    db = pool;
  } catch {
    db = null; // database not reachable: fixture tests are skipped
  }
});

afterAll(async () => {
  await closePool();
});

/** Resolve "Name", "Name|ISO2" or a QID to an entity id of the given type. */
async function resolve(pool: Pool, ref: string, type: string): Promise<string> {
  if (/^Q\d+$/.test(ref)) return ref;
  const [name, iso2] = ref.split("|");
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM entities WHERE type = $1 AND lower(name) = lower($2)
       AND ($3::text IS NULL OR attrs->>'iso2' = $3)
     ORDER BY popularity DESC NULLS LAST LIMIT 1`,
    [type, name, iso2 ?? null],
  );
  if (!rows[0]) throw new Error(`fixture references unknown ${type} "${ref}"`);
  return rows[0].id;
}

interface Outcome {
  c: Case;
  result?: MatchResult;
  ok: boolean;
  why?: string;
}

async function runCase(pool: Pool, c: Case): Promise<Outcome> {
  const expectId = c.expect ? await resolve(pool, c.expect, c.type) : undefined;
  const validRefs = c.valid ?? (c.expect ? [c.expect] : []);
  const valid = await Promise.all(validRefs.map((v) => resolve(pool, v, c.type)));
  const result = await matchAnswer(pool, c.in, { entityType: c.type, validIds: valid });

  const allowed = c.status
    ? [c.status].flat()
    : [expectId && valid.includes(expectId) ? "valid" : "real_but_wrong"];
  if (c.wrong && result.status === "valid") {
    return { c, result, ok: false, why: "WRONG ANSWER ACCEPTED AS VALID" };
  }
  if (!allowed.includes(result.status)) {
    return { c, result, ok: false, why: `status ${result.status}, wanted ${allowed.join("|")}` };
  }
  const landed = ["valid", "real_but_wrong", "did_you_mean"].includes(result.status);
  if (expectId && landed && result.entity?.id !== expectId &&
      !result.namesakes?.some((n) => n.id === expectId)) {
    return { c, result, ok: false, why: `matched ${result.entity?.name} (${result.entity?.id})` };
  }
  if (c.other_type && result.otherType !== c.other_type) {
    return { c, result, ok: false, why: `otherType ${result.otherType}, wanted ${c.other_type}` };
  }
  return { c, result, ok: true };
}

describe("matcher fixtures (pipeline/tests/match_cases.yaml)", () => {
  it(`has at least 100 cases (has ${CASES.length})`, () => {
    expect(CASES.length).toBeGreaterThanOrEqual(100);
  });

  it("passes >= 95% and never accepts a wrong answer as valid", async (ctx) => {
    if (!db) ctx.skip();
    const outcomes: Outcome[] = [];
    for (const c of CASES) outcomes.push(await runCase(db!, c));
    const failed = outcomes.filter((o) => !o.ok);
    const rate = (outcomes.length - failed.length) / outcomes.length;
    const report = failed
      .map((o) => `  ✗ [${o.c.type}] "${o.c.in}": ${o.why}` +
        (o.result ? ` (normalized "${o.result.normalized}")` : ""))
      .join("\n");
    console.log(`matcher fixtures: ${outcomes.length - failed.length}/${outcomes.length} pass ` +
      `(${(rate * 100).toFixed(1)}%)${report ? "\n" + report : ""}`);
    const snapped = failed.filter((o) => o.why === "WRONG ANSWER ACCEPTED AS VALID");
    expect(snapped.map((o) => o.c.in)).toEqual([]);
    expect(rate).toBeGreaterThanOrEqual(0.95);
  }, 120_000);

  it("TypeScript normalisation equals the Python alias_norm for a sample of real aliases",
    async (ctx) => {
      if (!db) ctx.skip();
      const { rows } = await db!.query<{ alias: string; alias_norm: string; type: string }>(
        `SELECT a.alias, a.alias_norm, e.type
         FROM aliases a TABLESAMPLE SYSTEM (2) REPEATABLE (42) JOIN entities e ON e.id = a.entity_id
         LIMIT 5000`,
      );
      const diffs = rows.filter((r) => normalize(r.alias, r.type) !== r.alias_norm);
      expect(diffs.slice(0, 10)).toEqual([]);
    }, 60_000);
});

describe("did you mean / confirm flow (needs the DB)", () => {
  it("confirms a suggestion, but not an unrelated entity", async (ctx) => {
    if (!db) ctx.skip();
    const nigeria = await resolve(db!, "Nigeria", "country");
    const france = await resolve(db!, "France", "country");
    const first = await matchAnswer(db!, "Nigera", { entityType: "country", validIds: [nigeria] });
    expect(first.status).toBe("did_you_mean");
    expect(first.suggestion?.id).toBe(nigeria);
    const ok = await matchAnswer(db!, "Nigera", {
      entityType: "country", validIds: [nigeria], confirmEntityId: nigeria,
    });
    expect(ok.status).toBe("valid");
    // "confirming" something the input doesn't resemble must not work (no fishing via confirm)
    const sneaky = await matchAnswer(db!, "Nigera", {
      entityType: "country", validIds: [france], confirmEntityId: france,
    });
    expect(sneaky.status).not.toBe("valid");
  });

  it("offers the obscure exact namesake as the alternative", async (ctx) => {
    if (!db) ctx.skip();
    const r = await matchAnswer(db!, "Edinburg", { entityType: "city", validIds: [] });
    expect(r.status).toBe("did_you_mean");
    expect(r.suggestion?.name).toBe("Edinburgh");
    expect(r.alternative?.name).toBe("Edinburg");
  });

  it("answers quickly (logs latency)", async (ctx) => {
    if (!db) ctx.skip();
    const inputs = ["Kathmandoo", "Lodnon", "Phillipines", "zzzzzzzz", "Heathrow Aiport", "JFK",
      "San Fransisco", "Buenos Aries", "Copenhagan", "Sweeden"];
    const times: number[] = [];
    for (const raw of inputs) {
      for (const type of ["city", "country", "airport"]) {
        const t0 = performance.now();
        await matchAnswer(db!, raw, { entityType: type, validIds: [] });
        times.push(performance.now() - t0);
      }
    }
    times.sort((a, b) => a - b);
    const p = (q: number) => times[Math.floor(q * (times.length - 1))].toFixed(0);
    console.log(`matcher latency: p50 ${p(0.5)} ms, p95 ${p(0.95)} ms, max ${p(1)} ms`);
    expect(Number(p(0.95))).toBeLessThan(500);
  }, 60_000);
});
