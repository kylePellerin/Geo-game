from collections import Counter
from datetime import date, timedelta

import pytest

from geo_pipeline.generate_puzzles import SLOT_DIFFICULTY, Past, eligible, pick_day
from geo_pipeline.questions import (
    Candidate,
    Template,
    compile_filter,
    expand,
    load_templates,
    overlap,
    rarity_category,
    validate,
)


def make_template(**kw) -> Template:
    base = {"id": "t", "family": "countries", "kind": "membership", "entity_type": "country",
            "difficulty": 1, "text": "Name a country", "filter": "TRUE"}
    base.update(kw)
    return Template(**base)


def test_all_templates_load_and_expand() -> None:
    templates = load_templates()
    assert len(templates) >= 15
    for t in templates:
        for c in expand(t):
            assert c.text.startswith("Name ")
            assert "{" not in c.text, c.text
            assert c.difficulty in (1, 2, 3)
            compile_filter(t, c.params)  # every param reference resolves


def test_validate_rejects_unknown_param() -> None:
    with pytest.raises(ValueError, match="unknown param"):
        validate(make_template(filter="e.name = :nope.x"))


def test_validate_rejects_text_field_missing_from_some_values() -> None:
    t = make_template(text="Name {p.text}", params={"p": [{"text": "a"}, {"other": "b"}]})
    with pytest.raises(ValueError, match="missing"):
        validate(t)


def test_compile_filter_binds_params_and_escapes_percent() -> None:
    t = make_template(
        filter="e.name LIKE '% %' AND e.attrs->>'k' = :p.key AND x::text = :p.missing",
        params={"p": [{"key": "v"}]},
    )
    sql, binds = compile_filter(t, {"p": {"key": "v"}})
    assert "'%% %%'" in sql  # literal % doubled for psycopg
    assert "::text" in sql  # casts untouched
    assert binds == {"p_p_key": "v", "p_p_missing": None}
    assert "%(p_p_key)s" in sql


def test_param_difficulty_override() -> None:
    t = make_template(text="Name {p.t}", params={"p": [{"t": "a"}, {"t": "b", "difficulty": 3}]})
    assert [c.difficulty for c in expand(t)] == [1, 3]
    assert all("difficulty" not in c.params["p"] for c in expand(t))


@pytest.mark.parametrize(
    ("pct", "cat"),
    [(0.99, "famous"), (0.85, "famous"), (0.84, "well_known"), (0.6, "well_known"),
     (0.5, "familiar"), (0.3, "familiar"), (0.29, "obscure"), (0.02, "obscure"),
     (0.019, "rarest"), (0.0, "rarest")],
)
def test_rarity_categories(pct: float, cat: str) -> None:
    assert rarity_category(pct) == cat


def test_overlap_is_jaccard() -> None:
    assert overlap({"a", "b"}, {"a", "b"}) == 1.0
    assert overlap({"a", "b", "c", "d"}, {"a", "b"}) == 0.5
    assert overlap({"a"}, set()) == 0.0


def cand(tid: str, family: str, diff: int, answers: list[str], famous: int = 5) -> Candidate:
    c = Candidate(make_template(id=tid, family=family, difficulty=diff), {}, f"Q {tid}", diff,
                  answers=answers)
    c.categories = {a: ("famous" if i < famous else "familiar") for i, a in enumerate(answers)}
    return c


def test_rejection_rules() -> None:
    # floor counts famous + well_known; 4 famous and the rest familiar -> floor fails
    assert cand("a", "f", 1, [f"x{i}" for i in range(12)], famous=4).rejection().startswith(
        "easy floor")
    assert cand("a", "f", 1, [f"x{i}" for i in range(9)]).rejection().startswith("too few")
    assert cand("a", "f", 1, [f"x{i}" for i in range(12)], famous=12).rejection().startswith(
        "tail")
    ok = cand("a", "f", 1, [f"x{i}" for i in range(12)], famous=5)
    assert ok.rejection() is None


def test_eligible_enforces_repeat_and_overlap_windows() -> None:
    day = date(2026, 1, 31)
    c = cand("t1", "flags", 1, [f"x{i}" for i in range(10)])
    same = Past(day - timedelta(days=59), c.key, "t1", "flags", set(c.answers))
    old = Past(day - timedelta(days=60), c.key, "t1", "flags", set(c.answers))
    similar = Past(day - timedelta(days=13), "other", "t2", "x", set(c.answers[:9]))
    assert not eligible(c, day, [same], [], set())
    assert eligible(c, day, [old], [], set())
    assert not eligible(c, day, [similar], [], set())
    assert eligible(c, day, [similar], [], set(), check_overlap=False)
    assert not eligible(c, day, [], [], {"flags"})


def test_pick_day_fills_slots_by_difficulty_with_distinct_families() -> None:
    families = ["flags", "countries", "cities", "names", "borders", "airports", "map"]
    pool = []
    for fam in families:
        for d in (1, 2, 3):
            for k in range(3):
                answers = [f"{fam}{d}{k}_{i}" for i in range(10)]
                pool.append(cand(f"{fam}-{d}-{k}", fam, d, answers))
    picked = pick_day(date(2026, 1, 1), pool, [], "test", Counter())
    assert [c.difficulty for c in picked] == SLOT_DIFFICULTY
    assert len({c.family for c in picked}) == 6
    # deterministic for the same date and salt
    again = pick_day(date(2026, 1, 1), pool, [], "test", Counter())
    assert [c.key for c in picked] == [c.key for c in again]


@pytest.mark.db
def test_every_candidate_query_runs_against_db() -> None:
    psycopg = pytest.importorskip("psycopg")
    from geo_pipeline.db import connect
    from geo_pipeline.questions import evaluate

    try:
        conn = connect()
    except psycopg.OperationalError:
        pytest.skip("database not reachable")
    with conn, conn.cursor() as cur:
        for t in load_templates():
            for c in expand(t):
                evaluate(cur, c)
                assert isinstance(c.answers, list)
