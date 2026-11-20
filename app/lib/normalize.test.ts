import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { normalize } from "./normalize";

type Case = { in: string; type?: string; out: string };
const cases: Case[] = parse(
  readFileSync(join(__dirname, "../../pipeline/tests/normalize_cases.yaml"), "utf8"),
);

describe("normalize matches the Python implementation (shared golden cases)", () => {
  it.each(cases.map((c) => [c.in, c.type ?? "", c.out]))("%s [%s] -> %s", (input, type, out) => {
    expect(normalize(input, type || undefined)).toBe(out);
  });
});
