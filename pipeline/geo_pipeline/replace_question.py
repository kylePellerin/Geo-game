"""Replace one question of an upcoming puzzle (admin page "Replace", PLAN.md §8 Phase 6).

  python -m geo_pipeline.replace_question --date 2026-12-01 --idx 2 [--dry-run]

Picks a different question of the same kind and difficulty that passes the generator's rules
against the rest of that day and the surrounding history. Refuses past dates and dates that
already have answers (puzzles are frozen once played).
"""

from __future__ import annotations

import argparse
import json
import random
from collections import Counter
from datetime import date, timedelta

from geo_pipeline import ordering
from geo_pipeline.common import log, setup_logging
from geo_pipeline.db import connect
from geo_pipeline.generate_puzzles import (
    REPEAT_DAYS,
    _history_rows,
    eligible,
    pick_match,
    pick_order,
    upsert_templates,
    utc_today,
    weight,
)
from geo_pipeline.matching import VARIANTS, load_pool
from geo_pipeline.questions import evaluate, expand, load_templates


def main(day: date, idx: int, dry_run: bool = False, salt: str = "replace") -> str:
    if day < utc_today():
        raise SystemExit(f"{day} is in the past; past puzzles are frozen")
    with connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT 1 FROM answers WHERE date = %s LIMIT 1", (day,))
        if cur.fetchone():
            raise SystemExit(f"{day} already has answers; it can't change")
        cur.execute(
            "SELECT kind, difficulty, family, template_id, params FROM puzzle_questions "
            "WHERE date = %s AND idx = %s", (day, idx))
        row = cur.fetchone()
        if not row:
            raise SystemExit(f"no question {idx} on {day}")
        kind, difficulty, family, old_template, old_params = row
        history = _history_rows(cur, "date >= %s AND date <= %s",
                                (day - timedelta(days=REPEAT_DAYS), day + timedelta(days=REPEAT_DAYS)))
        rest = [p for p in history if p.day != day]
        today_rest = _history_rows(cur, "date = %s AND idx <> %s", (day, idx))
        rng = random.Random(f"{salt}:{day}:{idx}:{old_template}:{json.dumps(old_params)}")

        if kind == "match":
            pools = {v.id: load_pool(cur, v) for v in VARIANTS if v.id != old_template}
            q = pick_match(day, difficulty, pools, rest, rng)
        elif kind == "order":
            pools = {v.id: ordering.load_pool(cur, v) for v in ordering.VARIANTS
                     if v.id != old_template}
            saved = ordering.VARIANTS
            ordering.VARIANTS = [v for v in saved if v.id != old_template]
            try:
                q = pick_order(day, pools, rest, rng)
            finally:
                ordering.VARIANTS = saved
        else:
            templates = load_templates()
            pool = [c for t in templates for c in expand(t)]
            for c in pool:
                evaluate(cur, c)
            pool = [c for c in pool if not c.rejection() and c.difficulty == difficulty
                    and c.template.id != old_template]
            used = Counter(p.family for p in today_rest)
            sets = [list(p.answers) for p in today_rest]
            options = [c for c in pool if eligible(c, day, rest, sets, used)]
            if not options:  # relax: allow a family already used today
                options = [c for c in pool if eligible(c, day, rest, sets, Counter())]
            q = rng.choices(options, weights=[weight(o, day, rest, sets) for o in options])[0] \
                if options else None
            if q is not None and not dry_run:
                upsert_templates(cur, templates)
        if q is None:
            raise SystemExit("no replacement found")
        if not dry_run:
            _write_one(cur, day, idx, q)
            cur.execute("UPDATE daily_puzzles SET reviewed = false WHERE date = %s", (day,))
        else:
            conn.rollback()
        msg = f"{day} #{idx + 1}: {q.text} (was {old_template}, family {family})"
        log.info("%s%s", msg, " (dry run)" if dry_run else "")
        return msg


def _write_one(cur, day: date, idx: int, q) -> None:
    from geo_pipeline.generate_puzzles import write_day

    # write_day rewrites the whole day; keep the other questions by re-inserting them as-is
    cur.execute(
        """CREATE TEMP TABLE keep_q ON COMMIT DROP AS
           SELECT * FROM puzzle_questions WHERE date = %s AND idx <> %s""", (day, idx))
    write_day(cur, day, [q])  # inserts q at idx 0
    cur.execute("UPDATE puzzle_questions SET idx = %s WHERE date = %s AND idx = 0", (idx, day))
    cur.execute("INSERT INTO puzzle_questions SELECT * FROM keep_q")


if __name__ == "__main__":
    setup_logging()
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    p.add_argument("--date", type=date.fromisoformat, required=True)
    p.add_argument("--idx", type=int, required=True, help="0-based question index")
    p.add_argument("--dry-run", action="store_true")
    a = p.parse_args()
    print(main(a.date, a.idx, a.dry_run))
