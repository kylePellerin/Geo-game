"""Practice pool (PLAN.md phase 7): questions anyone can replay at any time, never scored.

Every free-text candidate that passes the daily checks, plus a few matching and ordering rounds per
variant. Answer sets are frozen in practice_questions like daily ones. Re-running replaces the pool
(practice answers are never stored, so nothing refers to old rows).

Practice answers are rated by how well known the answer is (the rarity category computed here),
since there are no other players' answers to compare against.
"""

from __future__ import annotations

import argparse
import json
import random

from geo_pipeline import ordering
from geo_pipeline.common import log, setup_logging
from geo_pipeline.db import connect
from geo_pipeline.generate_puzzles import upsert_templates
from geo_pipeline.matching import VARIANTS, build_round, load_pool
from geo_pipeline.questions import evaluate, expand, load_templates

ROUNDS_PER_VARIANT = 4


def main(seed: int = 7) -> None:
    rng = random.Random(seed)
    templates = load_templates()
    with connect() as conn, conn.cursor() as cur:
        upsert_templates(cur, templates)
        rows = []
        for t in templates:
            for c in expand(t):
                evaluate(cur, c)
                if c.rejection():
                    continue
                rows.append((c.template.id, json.dumps(c.params), c.text, c.answers, c.family,
                             t.entity_type, c.difficulty, "free_text",
                             json.dumps({"territories": t.territories,
                                         "answer_rarity": c.categories})))
        n_free = len(rows)
        for v in VARIANTS:
            pool = load_pool(cur, v)
            used: set[str] = set()
            for i in range(ROUNDS_PER_VARIANT):
                r = build_round(v, pool, 2, rng, used)
                if not r:
                    break
                used |= set(r.answers)
                rows.append((v.id, json.dumps({"n": i}), r.text, r.answers, "matching",
                             v.left_type, r.difficulty, "match", json.dumps(r.payload())))
        for v in ordering.VARIANTS:
            pool = ordering.load_pool(cur, v)
            used = set()
            for i in range(ROUNDS_PER_VARIANT):
                r = ordering.build_round(v, pool, 2, rng, used)
                if not r:
                    break
                used |= set(r.answers)
                rows.append((v.id, json.dumps({"n": i}), r.text, r.answers, "ordering",
                             v.entity_type, r.difficulty, "order", json.dumps(r.payload())))
        cur.execute("DELETE FROM practice_questions")
        cur.executemany(
            """INSERT INTO practice_questions (template_id, params, question_text, valid_entity_ids,
                   family, entity_type, difficulty, kind, payload)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            rows,
        )
    log.info("practice pool: %d free-text questions, %d rounds", n_free, len(rows) - n_free)


if __name__ == "__main__":
    setup_logging()
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--seed", type=int, default=7)
    main(p.parse_args().seed)
