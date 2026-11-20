"""Generate daily puzzles (PLAN.md §4, QUESTIONS.md §2).

  python -m geo_pipeline.generate_puzzles --from 2026-12-01 --days 30 [--print] [--dry-run]

For each date: 6 questions, slots 1-3 easy, 4-5 medium, 6 hard.
- Families differ within a day, except flags, which may appear twice (one easy + one medium).
- A flag question every day; airports appear less often (FAMILY_WEIGHT).
- On most days one easy or medium slot is a matching round (geo_pipeline.matching).
- Every free-text question passes its template's answer-count and rarity floor/tail checks.
- Never the identical template+params within 60 days. Similar answer sets (Jaccard > 0.5) within
  14 days are allowed but strongly down-weighted.
- Seeded by date, so a rerun with the same data and templates reproduces the same puzzles.

Answer sets are frozen into puzzle_questions. Existing dates are skipped (--replace regenerates
them, except dates that are reviewed, in the past, or already have answers).
"""

from __future__ import annotations

import argparse
import json
import random
from collections import Counter
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta

from geo_pipeline.common import log, setup_logging
from geo_pipeline.db import connect
from geo_pipeline.matching import VARIANTS, MatchRound, build_round, load_pool
from geo_pipeline.questions import Candidate, Template, evaluate, expand, load_templates, overlap

SLOT_DIFFICULTY = [1, 1, 1, 2, 2, 3]
REPEAT_DAYS = 60
OVERLAP_DAYS = 14
MAX_OVERLAP = 0.5
OVERLAP_PENALTY = 0.05  # weight multiplier for a question similar to a recent one
FLAG_PROBABILITY = 1.0  # a flag question every day
SECOND_FLAG_PROBABILITY = 0.2  # ...and sometimes a second, harder one
FAMILY_MAX_PER_DAY = {"flags": 2}  # only on "second flag" days; otherwise 1
FAMILY_MAX_PER_WEEK = {"airports": 2}  # airports kept occasional (2026-11-20)
# Relative frequency of families in the daily mix (default 1.0).
FAMILY_WEIGHT = {"flags": 1.5, "airports": 0.15}
MATCH_PROBABILITY = 1.0  # a matching round every day (2026-11-20)
MATCH_VARIANT_GAP_DAYS = 4  # don't repeat a matching variant within this many days
MATCH_FRESH_DAYS = 21  # don't reuse a matching item within this many days
# If a slot has no candidate at its difficulty, borrow from these (logged as a fallback).
FALLBACK_DIFFICULTY = {1: [2], 2: [1, 3], 3: [2]}

Question = Candidate | MatchRound


@dataclass
class Past:
    day: date
    key: str
    template_id: str
    family: str
    answers: set[str]


def utc_today() -> date:
    return datetime.now(UTC).date()


def key_of(q: Question) -> str:
    if isinstance(q, MatchRound):
        return q.variant.id + json.dumps(sorted(q.answers))
    return q.key


def template_id_of(q: Question) -> str:
    return q.variant.id if isinstance(q, MatchRound) else q.template.id


def upsert_templates(cur, templates: list[Template]) -> None:
    rows = [(t.id, t.kind, t.entity_type, t.text, json.dumps(t.params), t.filter,
             t.min_answers, t.max_answers, t.difficulty, t.family) for t in templates]
    rows += [(v.id, "match", v.left_type, v.text, "{}", v.pool_sql, 4, 4, 1, "matching")
             for v in VARIANTS]
    for row in rows:
        cur.execute(
            """INSERT INTO question_templates (id, kind, entity_type, text_pattern, params_schema,
                   sql_or_filter, min_answers, max_answers, difficulty, family)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
               ON CONFLICT (id) DO UPDATE SET kind = EXCLUDED.kind,
                 entity_type = EXCLUDED.entity_type, text_pattern = EXCLUDED.text_pattern,
                 params_schema = EXCLUDED.params_schema, sql_or_filter = EXCLUDED.sql_or_filter,
                 min_answers = EXCLUDED.min_answers, max_answers = EXCLUDED.max_answers,
                 difficulty = EXCLUDED.difficulty, family = EXCLUDED.family""",
            row,
        )


def _history_rows(cur, where: str, params: tuple) -> list[Past]:
    cur.execute(
        f"""SELECT date, template_id, params, family, valid_entity_ids, kind FROM puzzle_questions
            WHERE {where}""",
        params,
    )
    out = []
    for d, tid, p, fam, ids, kind in cur.fetchall():
        key = tid + (json.dumps(sorted(ids)) if kind == "match" else json.dumps(p, sort_keys=True))
        out.append(Past(d, key, tid, fam, set(ids)))
    return out


def load_history(cur, start: date) -> list[Past]:
    return _history_rows(cur, "date >= %s AND date < %s",
                         (start - timedelta(days=REPEAT_DAYS), start))


def load_history_for(cur, day: date) -> list[Past]:
    return _history_rows(cur, "date = %s", (day,))


def eligible(c: Candidate, day: date, history: list[Past], today_sets: list[list[str]],
             used_families: set[str] | Counter, check_overlap: bool = True,
             used_templates: set[str] | None = None,
             day_limits: dict[str, int] | None = None) -> bool:
    """Hard rules for a free-text candidate. used_templates set => family reuse is allowed."""
    if used_templates is None:
        count = used_families[c.family] if isinstance(used_families, Counter) else (
            1 if c.family in used_families else 0)
        if count >= (day_limits or {}).get(c.family, 1):
            return False
    elif c.template.id in used_templates:
        return False  # family reuse is a fallback, but never the same template twice in a day
    if (cap := FAMILY_MAX_PER_WEEK.get(c.family)) is not None:
        week = sum(1 for p in history if p.family == c.family and 0 < (day - p.day).days < 7)
        if week + (used_families[c.family] if isinstance(used_families, Counter) else 0) >= cap:
            return False
    for p in history:
        age = (day - p.day).days
        if p.key == c.key and age < REPEAT_DAYS:
            return False
        if check_overlap and age < OVERLAP_DAYS and overlap(c.answers, p.answers) > MAX_OVERLAP:
            return False
    return not (check_overlap and any(overlap(c.answers, s) > MAX_OVERLAP for s in today_sets))


def weight(c: Candidate, day: date, history: list[Past], today_sets: list[list[str]]) -> float:
    """Family frequency, recency of template/family use, and a penalty for similar answer sets."""
    t_uses = sum(1 for p in history if p.template_id == c.template.id and (day - p.day).days < 30)
    f_uses = sum(1 for p in history if p.family == c.family and (day - p.day).days < 7)
    w = FAMILY_WEIGHT.get(c.family, 1.0) / ((1 + t_uses) ** 2 * (1 + f_uses))
    recent = [p.answers for p in history if (day - p.day).days < OVERLAP_DAYS]
    if any(overlap(c.answers, s) > MAX_OVERLAP for s in [*recent, *today_sets]):
        w *= OVERLAP_PENALTY
    return w


def pick_match(day: date, slot_diff: int, pools: dict, history: list[Past],
               rng: random.Random) -> MatchRound | None:
    recent_items = set().union(*[p.answers for p in history if p.family == "matching"
                                 and (day - p.day).days < MATCH_FRESH_DAYS] or [set()])
    recent_variants = {p.template_id for p in history if p.family == "matching"
                       and (day - p.day).days < MATCH_VARIANT_GAP_DAYS}
    options = [v for v in VARIANTS if slot_diff in v.difficulties]
    fresh = [v for v in options if v.id not in recent_variants] or options
    # weighted order without replacement (flags most often)
    order = []
    while fresh:
        v = rng.choices(fresh, weights=[x.weight for x in fresh])[0]
        order.append(v)
        fresh.remove(v)
    for v in order:
        r = build_round(v, pools[v.id], slot_diff, rng, recent_items)
        if r:
            return r
    return None


def pick_day(day: date, pool: list[Candidate], history: list[Past], salt: str,
             stats: Counter, match_pools: dict | None = None) -> list[Question]:
    rng = random.Random(f"{salt}:{day.isoformat()}")
    want_flag = rng.random() < FLAG_PROBABILITY
    want_second_flag = rng.random() < SECOND_FLAG_PROBABILITY
    match_slot = None
    if match_pools and rng.random() < MATCH_PROBABILITY:
        match_slot = rng.choice([2, 3])  # last easy slot or first medium slot
    chosen: dict[int, Question] = {}
    used: Counter = Counter()
    day_limits = {"flags": FAMILY_MAX_PER_DAY["flags"] if want_second_flag else 1}
    if match_slot is not None:
        m = pick_match(day, SLOT_DIFFICULTY[match_slot], match_pools, history, rng)
        if m:
            chosen[match_slot] = m
            used["matching"] += 1
    # Easy slots first: their families (flags, countries, cities, names) are the most constrained.
    # Then hard (small pool), then medium.
    for slot in [0, 1, 2, 5, 3, 4]:
        if slot in chosen:
            continue
        diff = SLOT_DIFFICULTY[slot]
        sets = [q.answers for q in chosen.values()]
        tiers = [
            (diff, None),
            *[(d, f"difficulty {diff}->{d}") for d in FALLBACK_DIFFICULTY[diff]],
            *[(d, f"difficulty {diff}->{d} (last resort)")
              for d in (1, 2, 3) if d != diff and d not in FALLBACK_DIFFICULTY[diff]],
            # while there are only a few families (more arrive in Phase 6): reuse a family
            *[(d, "family reused") for d in (diff, *FALLBACK_DIFFICULTY[diff])],
            *[(d, "template reused") for d in (diff, *FALLBACK_DIFFICULTY[diff])],
        ]
        templates_today = {template_id_of(q) for q in chosen.values()}
        keys_today = {key_of(q) for q in chosen.values()}
        for d, note in tiers:
            reuse = (templates_today if note == "family reused"
                     else set() if note == "template reused" else None)
            options = [c for c in pool if c.difficulty == d and c.key not in keys_today
                       and eligible(c, day, history, sets, used, False, reuse, day_limits)]
            wants_flag = (slot == 0 and want_flag) or (slot == 3 and want_second_flag)
            if wants_flag and used["flags"] < day_limits["flags"]:
                options = [c for c in options if c.family == "flags"] or options
            if options:
                break
        else:
            raise SystemExit(f"{day}: no candidate for slot {slot + 1} (difficulty {diff})")
        if note:
            stats[note] += 1
            log.warning("%s slot %d: %s", day, slot + 1, note)
        c = rng.choices(options, weights=[weight(o, day, history, sets) for o in options])[0]
        if any(overlap(c.answers, s) > MAX_OVERLAP for s in
               [p.answers for p in history if (day - p.day).days < OVERLAP_DAYS] + sets):
            stats["similar to a recent question"] += 1
        chosen[slot] = c
        used[c.family] += 1
    # shuffle within the easy and medium bands so the flag question isn't always first
    easy, medium = [chosen[i] for i in (0, 1, 2)], [chosen[i] for i in (3, 4)]
    rng.shuffle(easy)
    rng.shuffle(medium)
    return easy + medium + [chosen[5]]


def describe(cur, q: Question, n: int = 3) -> str:
    if isinstance(q, MatchRound):
        cur.execute("SELECT id, name FROM entities WHERE id = ANY(%s)", (q.answers,))
        names = dict(cur.fetchall())
        return " | ".join(f"{names[i.left]} -> {i.right_label} ({i.category})" for i in q.items)
    cur.execute(
        "SELECT name FROM entities WHERE id = ANY(%s) ORDER BY popularity DESC NULLS LAST",
        (q.answers,),
    )
    names = [r[0] for r in cur.fetchall()]
    rare = ", ".join(names[-2:]) if len(names) > n else ""
    return f"common: {', '.join(names[:n])} | rare: {rare}"


def write_day(cur, day: date, questions: list[Question]) -> None:
    cur.execute("DELETE FROM puzzle_questions WHERE date = %s", (day,))
    cur.execute(
        "INSERT INTO daily_puzzles (date) VALUES (%s) ON CONFLICT (date) DO UPDATE "
        "SET created_at = now(), reviewed = false",
        (day,),
    )
    for idx, q in enumerate(questions):
        if isinstance(q, MatchRound):
            row = (day, idx, q.variant.id, "{}", q.text, q.answers, "matching",
                   q.variant.left_type, q.difficulty, json.dumps({"n_pairs": 4}), "match",
                   json.dumps(q.payload()))
        else:
            row = (day, idx, q.template.id, json.dumps(q.params), q.text, q.answers, q.family,
                   q.template.entity_type, q.difficulty,
                   json.dumps({"n_answers": len(q.answers), "rarity": q.category_counts,
                               "answer_rarity": q.categories}), "free_text", "{}")
        cur.execute(
            """INSERT INTO puzzle_questions (date, idx, template_id, params, question_text,
                   valid_entity_ids, family, entity_type, difficulty, stats, kind, payload)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            row,
        )


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    p.add_argument("--from", dest="start", type=date.fromisoformat,
                   default=utc_today() + timedelta(days=1))
    p.add_argument("--days", type=int, default=30)
    p.add_argument("--replace", action="store_true", help="regenerate dates that already exist")
    p.add_argument("--dry-run", action="store_true", help="don't write to the database")
    p.add_argument("--print", action="store_true", help="print the generated puzzles")
    p.add_argument("--salt", default="v1", help="change to get a different sequence")
    p.add_argument("--allow-past", action="store_true", help="allow dates before today (dev)")
    a = p.parse_args()

    templates = load_templates()
    pool = [c for t in templates for c in expand(t)]
    with connect() as conn, conn.cursor() as cur:
        for c in pool:
            evaluate(cur, c)
        rejected = [c for c in pool if c.rejection()]
        pool = [c for c in pool if not c.rejection()]
        match_pools = {v.id: load_pool(cur, v) for v in VARIANTS}
        log.info("%d templates, %d candidates pass, %d rejected; passing by difficulty: %s",
                 len(templates), len(pool), len(rejected),
                 dict(sorted(Counter(c.difficulty for c in pool).items())))

        if not a.dry_run:
            upsert_templates(cur, templates)
        history = load_history(cur, a.start)
        cur.execute("SELECT date, reviewed FROM daily_puzzles WHERE date >= %s AND date < %s",
                    (a.start, a.start + timedelta(days=a.days)))
        existing = dict(cur.fetchall())
        cur.execute("SELECT DISTINCT date FROM answers WHERE date >= %s", (a.start,))
        answered = {r[0] for r in cur.fetchall()}

        stats: Counter = Counter()
        for i in range(a.days):
            day = a.start + timedelta(days=i)
            if day < utc_today() and not a.allow_past:
                raise SystemExit(f"{day} is in the past; past puzzles are frozen")
            if day in existing and (not a.replace or existing[day] or day in answered):
                why = "exists" if not a.replace else "is reviewed or has answers"
                log.info("%s %s, skipping", day, why)
                history += load_history_for(cur, day)
                continue
            questions = pick_day(day, pool, history, a.salt, stats, match_pools)
            for q in questions:
                history.append(Past(day, key_of(q), template_id_of(q), q.family, set(q.answers)))
            if not a.dry_run:
                write_day(cur, day, questions)
            if a.print:
                print(f"\n=== {day} ===")
                for idx, q in enumerate(questions):
                    size = "4 pairs" if isinstance(q, MatchRound) else f"{len(q.answers)} answers"
                    print(f"{idx + 1}. [{q.family}/d{q.difficulty}] {q.text}  ({size})\n"
                          f"     {describe(cur, q)}")
        if stats:
            log.warning("fallbacks used: %s", dict(stats))
        if a.dry_run:
            conn.rollback()
    log.info("done%s", " (dry run, nothing written)" if a.dry_run else "")


if __name__ == "__main__":
    setup_logging()
    main()
