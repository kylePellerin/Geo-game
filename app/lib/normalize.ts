/**
 * Text normalisation for player input. A port of pipeline/geo_pipeline/normalize.py, which
 * normalises aliases at load time: the two must stay identical. Both are checked against
 * pipeline/tests/normalize_cases.yaml (see normalize.test.ts). Rules are listed in the Python file.
 */

const TRANSLIT: Record<string, string> = {
  ß: "ss", æ: "ae", Æ: "ae", ø: "o", Ø: "o", œ: "oe", Œ: "oe",
  đ: "d", Đ: "d", ð: "d", þ: "th", ł: "l", Ł: "l", ı: "i",
  "’": "'", "‘": "'", "`": "'", "´": "'", "–": "-", "—": "-",
};
const TRANSLIT_RE = new RegExp(`[${Object.keys(TRANSLIT).join("")}]`, "gu");

export const TYPE_AFFIXES: Record<string, string[]> = {
  airport: [
    "international airport", "intl airport", "regional airport", "airport",
    "international", "internacional", "intl", "aeropuerto", "aeroporto", "aeroport",
    "flughafen", "aerodrome", "air force base", "air base", "airfield",
  ],
  national_park: ["national park", "np", "park"],
  river: ["river", "rio", "riviere"],
  lake: ["lake", "lago", "lac"],
  mountain: ["mountain", "mount", "mt", "monte", "mont"],
  forest: ["national forest", "forest"],
  island: ["islands", "island", "isla", "isle"],
  volcano: ["volcano", "volcan", "mount", "mt"],
};

export const TYPE_SUFFIXES: Record<string, string[]> = {
  city: ["city"],
};

const LEADING_PREPOSITIONS = ["de la", "del", "de", "d", "di", "da", "do", "du", "of"];

// Python's \w with re.UNICODE: letters, digits, marks? No: \w = [\p{L}\p{N}_] (marks are not \w).
const W = "[\\p{L}\\p{N}_]";
const ABBREV: [RegExp, string][] = [
  [new RegExp(`(?<!${W})st(?!${W})\\.?`, "gu"), "saint "],
  [new RegExp(`(?<!${W})ste(?!${W})\\.?`, "gu"), "sainte "],
  [new RegExp(`(?<!${W})ft(?!${W})\\.?`, "gu"), "fort "],
];

const isMark = (c: string) => /\p{M}/u.test(c);
const translit = (s: string) => s.replace(TRANSLIT_RE, (c) => TRANSLIT[c] ?? c);

export function basicNormalize(text: string): string {
  let s = translit(text).normalize("NFKD");
  // Strip accents only from Latin/Greek/Cyrillic letters; elsewhere marks are vowel signs.
  let out = "";
  let prevAlphabetic = false;
  for (const c of s) {
    if (isMark(c)) {
      if (prevAlphabetic) continue;
    } else {
      prevAlphabetic = c.codePointAt(0)! < 0x0530;
    }
    out += c;
  }
  s = translit(out.normalize("NFC").toLowerCase());
  s = s.replaceAll("&", " and ").replaceAll("'", "");
  for (const [re, repl] of ABBREV) s = s.replace(re, repl);
  s = s.replaceAll(".", "");
  s = Array.from(s, (c) => (/[\p{L}\p{N}\p{M}\s]/u.test(c) && c !== "_" ? c : " ")).join("");
  s = s.replace(/\s+/gu, " ").trim();
  if (s.startsWith("the ")) s = s.slice(4);
  return s;
}

export function normalize(text: string, entityType?: string | null): string {
  let s = basicNormalize(text);
  const affixes = TYPE_AFFIXES[entityType ?? ""] ?? [];
  let changed = true;
  while (changed && affixes.length) {
    changed = false;
    for (const a of affixes) {
      if (s.endsWith(" " + a)) {
        s = s.slice(0, -a.length - 1).trim();
        changed = true;
      } else if (s.startsWith(a + " ")) {
        s = s.slice(a.length + 1).trim();
        changed = true;
        for (const prep of LEADING_PREPOSITIONS) {
          if (s.startsWith(prep + " ") && s.length > prep.length + 1) {
            s = s.slice(prep.length + 1);
            break;
          }
        }
      }
      if (s.startsWith("the ")) s = s.slice(4);
    }
  }
  for (const suffix of TYPE_SUFFIXES[entityType ?? ""] ?? []) {
    if (s.endsWith(" " + suffix)) s = s.slice(0, -suffix.length - 1).trim();
  }
  return s;
}
