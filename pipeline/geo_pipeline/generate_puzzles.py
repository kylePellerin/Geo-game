"""Generate daily puzzles (PLAN.md §4, QUESTIONS.md §2).

  python -m geo_pipeline.generate_puzzles --from 2026-12-01 --days 30 [--print] [--dry-run]

For each date: 6 questions from 6 different families, slots 1-3 easy, 4-5 medium, 6 hard, with a
flag question on most days. Every question passes its template's answer-count and easy-floor/tail
checks. No identical template+params within 60 days; no answer-set overlap > 50% with any question
in the previous 14 days (or the same day). Choices are seeded by date, so a rerun with the same
data and templates reproduces the same puzzles.

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
from geo_pipeline.questions import Candidate, Template, evaluate, expand, load_templates, overlap

SLOT_DIFFICULTY = [1, 1, 1, 2, 2, 3]
REPEAT_DAYS = 60
OVERLAP_DAYS = 14
MAX_OVERLAP = 0.5
FLAG_PROBABILITY = 0.8  # "a flag question on most days"
# If a slot has no candidate at its difficulty, borrow from these (logged as a fallback).
FALLBACK_DIFFICULTY = {1: [2], 2: [1, 3], 3: [2]}


@dataclass
class Past:
    day: date
    key: str
    template_id: str
    family: str
    answers: set[str]


def utc_today() -> date:
    return datetime.now(UTC).date()


def upsert_templates(cur, templates: list[Template]) -> None:
    for t in templates:
        cur.execute(
            """INSERT INTO question_templates (id, kind, entity_type, text_pattern, params_schema,
                   sql_or_filter, min_answers, max_answers, difficulty, family)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
               ON CONFLICT (id) DO UPDATE SET kind = EXCLUDED.kind,
                 entity_type = EXCLUDED.entity_type, text_pattern = EXCLUDED.text_pattern,
                 params_schema = EXCLUDED.params_schema, sql_or_filter = EXCLUDED.sql_or_filter,
                 min_answers = EXCLUDED.min_answers, max_answers = EXCLUDED.max_answers,
                 difficulty = EXCLUDED.difficulty, family = EXCLUDED.family""",
            (t.id, t.kind, t.entity_type, t.text, json.dumps(t.params), t.filter,
             t.min_answers, t.max_answers, t.difficulty, t.family),
        )


def load_history(cur, start: date) -> list[Past]:
    cur.execute(
        """SELECT date, template_id, params, family, valid_entity_ids FROM puzzle_questions
           WHERE date >= %s AND date < %s""",
        (start - timedelta(days=REPEAT_DAYS), start),
    )
    return [
        Past(d, tid + json.dumps(p, sort_keys=True), tid, fam, set(ids))
        for d, tid, p, fam, ids in cur.fetchall()
    ]


def eligible(c: Candidate, day: date, history: list[Past], today_sets: list[list[str]],
             used_families: set[str], check_overlap: bool = True,
             used_templates: set[str] | None = None) -> bool:
    if used_templates is None:
        if c.family in used_families:
            return False
    elif c.template.id in used_templates:
        # family reuse allowed (last resort), but never the same template twice in a day
        return False
    for p in history:
        age = (day - p.day).days
        if p.key == c.key and age < REPEAT_DAYS:
            return False
        if check_overlap and age < OVERLAP_DAYS and overlap(c.answers, p.answers) > MAX_OVERLAP:
            return False
    return not (check_overlap and any(overlap(c.answers, s) > MAX_OVERLAP for s in today_sets))


def weight(c: Candidate, day: date, history: list[Past]) -> float:
    """Prefer templates and families not used recently, so the mix stays varied."""
    t_uses = sum(1 for p in history if p.template_id == c.template.id and (day - p.day).days < 30)
    f_uses = sum(1 for p in history if p.family == c.family and (day - p.day).days < 7)
    return 1.0 / ((1 + t_uses) ** 2 * (1 + f_uses))


def pick_day(day: date, pool: list[Candidate], history: list[Past], salt: str,
             stats: Counter) -> list[Candidate]:
    rng = random.Random(f"{salt}:{day.isoformat()}")
    want_flag = rng.random() < FLAG_PROBABILITY
    chosen: dict[int, Candidate] = {}
    used: set[str] = set()
    # Easy slots first: their families (flags, countries, cities, names) are the most constrained,
    # and medium/hard picks could otherwise use them all up. Then hard (small pool), then medium.
    order = [0, 1, 2, 5, 3, 4]
    for slot in order:
        diff = SLOT_DIFFICULTY[slot]
        sets = [c.answers for c in chosen.values()]
        tiers = [
            (diff, True, None), (diff, False, "overlap relaxed"),
            *[(d, True, f"difficulty {diff}->{d}") for d in FALLBACK_DIFFICULTY[diff]],
            *[(d, False, f"difficulty {diff}->{d}, overlap relaxed")
              for d in FALLBACK_DIFFICULTY[diff]],
            *[(d, False, f"difficulty {diff}->{d} (last resort)")
              for d in (1, 2, 3) if d != diff and d not in FALLBACK_DIFFICULTY[diff]],
        ]
        # Last resort while there are only a few families (more arrive in Phase 6): reuse a family.
        tiers += [(d, False, "family reused") for d in (diff, *FALLBACK_DIFFICULTY[diff])]
        tiers += [(d, False, "template reused") for d in (diff, *FALLBACK_DIFFICULTY[diff])]
        templates_today = {c.template.id for c in chosen.values()}
        keys_today = {c.key for c in chosen.values()}
        for d, check, note in tiers:
            reuse = (templates_today if note == "family reused"
                     else set() if note == "template reused" else None)
            options = [c for c in pool if c.difficulty == d
                       and eligible(c, day, history, sets, used, check, reuse)]
            if slot == 0 and want_flag and "flags" not in used:
                flag_opts = [c for c in options if c.family == "flags"]
                options = flag_opts or options
            options = [c for c in options if c.key not in keys_today]
            if options:
                break
        else:
            raise SystemExit(f"{day}: no candidate for slot {slot + 1} (difficulty {diff})")
        if note:
            stats[note] += 1
            log.warning("%s slot %d: %s", day, slot + 1, note)
        c = rng.choices(options, weights=[weight(o, day, history) for o in options])[0]
        chosen[slot] = c
        used.add(c.family)
    # shuffle within the easy and medium bands so the flag question isn't always first
    easy, medium = [chosen[i] for i in (0, 1, 2)], [chosen[i] for i in (3, 4)]
    rng.shuffle(easy)
    rng.shuffle(medium)
    return easy + medium + [chosen[5]]


def describe(cur, c: Candidate, n: int = 3) -> str:
    cur.execute(
        "SELECT name FROM entities WHERE id = ANY(%s) ORDER BY popularity DESC NULLS LAST",
        (c.answers,),
    )
    names = [r[0] for r in cur.fetchall()]
    rare = ", ".join(names[-2:]) if len(names) > n else ""
    return f"common: {', '.join(names[:n])} | rare: {rare}"


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
            if day in existing:
                if not a.replace:
                    log.info("%s exists, skipping", day)
                    history += load_history_for(cur, day)
                    continue
                if existing[day] or day in answered:
                    log.info("%s is reviewed or has answers; not replacing", day)
                    history += load_history_for(cur, day)
                    continue
            questions = pick_day(day, pool, history, a.salt, stats)
            for c in questions:
                history.append(Past(day, c.key, c.template.id, c.family, set(c.answers)))
            if not a.dry_run:
                write_day(cur, day, questions)
            if a.print:
                print(f"\n=== {day} ===")
                for idx, c in enumerate(questions):
                    print(f"{idx + 1}. [{c.family}/d{c.difficulty}] {c.text}  "
                          f"({len(c.answers)} answers)\n     {describe(cur, c)}")
        if stats:
            log.warning("fallbacks used: %s", dict(stats))
        if a.dry_run:
            conn.rollback()
    log.info("done%s", " (dry run, nothing written)" if a.dry_run else "")


def load_history_for(cur, day: date) -> list[Past]:
    cur.execute(
        "SELECT template_id, params, family, valid_entity_ids FROM puzzle_questions WHERE date = %s",
        (day,),
    )
    return [Past(day, t + json.dumps(p, sort_keys=True), t, f, set(ids))
            for t, p, f, ids in cur.fetchall()]


def write_day(cur, day: date, questions: list[Candidate]) -> None:
    cur.execute("DELETE FROM puzzle_questions WHERE date = %s", (day,))
    cur.execute(
        "INSERT INTO daily_puzzles (date) VALUES (%s) ON CONFLICT (date) DO UPDATE "
        "SET created_at = now(), reviewed = false",
        (day,),
    )
    for idx, c in enumerate(questions):
        cur.execute(
            """INSERT INTO puzzle_questions (date, idx, template_id, params, question_text,
                   valid_entity_ids, family, entity_type, difficulty, stats)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            (day, idx, c.template.id, json.dumps(c.params), c.text, c.answers, c.family,
             c.template.entity_type, c.difficulty,
             json.dumps({"n_answers": len(c.answers), "rarity": c.category_counts,
                         "answer_rarity": c.categories})),
        )


if __name__ == "__main__":
    setup_logging()
    main()
