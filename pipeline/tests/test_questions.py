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


# ---- matching rounds and daily-mix rules

def _match_pool(n_per_cat: int = 6):
    from geo_pipeline.matching import MatchItem

    cats = ["famous", "well_known", "familiar", "obscure"]
    return [MatchItem(f"{c}{i}", f"R{c}{i}", f"Right {c}{i}", c, f"X{c[0]}{i}")
            for c in cats for i in range(n_per_cat)]


def test_match_round_easy_and_medium_mix() -> None:
    import random

    from geo_pipeline.matching import VARIANTS, build_round

    v = VARIANTS[0]
    easy = build_round(v, _match_pool(), 1, random.Random(1), set())
    assert sorted(i.category for i in easy.items) == ["famous", "famous", "well_known",
                                                      "well_known"]
    medium = build_round(v, _match_pool(), 2, random.Random(1), set())
    # standard daily round (2026-11-20): 1 well known + 2 familiar + 1 obscure/rarest
    cats = sorted(i.category for i in medium.items)
    assert cats.count("familiar") == 2 and cats.count("well_known") == 1
    assert sum(c in {"obscure", "rarest"} for c in cats) == 1
    for r in (easy, medium):
        assert len({i.right for i in r.items}) == 4
        assert sorted(r.right_order) == sorted(i.right for i in r.items)
        assert r.right_order != [i.right for i in r.items]  # never shown pre-aligned


def test_match_round_avoids_recent_items_and_look_alike_flags() -> None:
    import random

    from geo_pipeline.matching import VARIANTS, MatchItem, build_round

    pool = [MatchItem("td", "td", "Chad", "famous", "TD"), MatchItem("ro", "ro", "Romania",
            "famous", "RO"), MatchItem("fr", "fr", "France", "famous", "FR"),
            MatchItem("jp", "jp", "Japan", "well_known", "JP"),
            MatchItem("br", "br", "Brazil", "well_known", "BR")]
    for seed in range(20):
        r = build_round(VARIANTS[0], pool, 1, random.Random(seed), set())
        assert r is not None
        assert not {"td", "ro"} <= set(r.answers)
    assert build_round(VARIANTS[0], pool, 1, random.Random(0), {"fr", "td"}) is None


def test_airports_capped_per_week() -> None:
    day = date(2026, 1, 10)
    c = cand("air", "airports", 2, [f"a{i}" for i in range(10)])
    hist = [Past(day - timedelta(days=k), f"k{k}", f"t{k}", "airports", {f"z{k}"})
            for k in (2, 5)]
    assert not eligible(c, day, hist, [], Counter())
    assert eligible(c, day, hist[:1], [], Counter())
    old = [Past(day - timedelta(days=7), "k", "t", "airports", {"z"})] * 3
    assert eligible(c, day, old, [], Counter())


def test_flags_twice_only_on_second_flag_days() -> None:
    day = date(2026, 1, 10)
    c = cand("fl", "flags", 2, [f"f{i}" for i in range(10)])
    used = Counter({"flags": 1})
    assert not eligible(c, day, [], [], used, day_limits={"flags": 1})
    assert eligible(c, day, [], [], used, day_limits={"flags": 2})


def test_match_round_rejects_ambiguous_pairs() -> None:
    import random

    from geo_pipeline.matching import VARIANTS, MatchItem, build_round

    # Stockholm hosted 1912 and 1956; Melbourne 1956. Shown together, Stockholm would also
    # match Melbourne's "1956", so they must never share a round.
    pool = [MatchItem("sto", "1912 summer", "1912 Summer", "famous", "SE", frozenset(
                {"1912 summer", "1956 summer"})),
            MatchItem("mel", "1956 summer", "1956 Summer", "famous", "AU",
                      frozenset({"1956 summer"})),
            MatchItem("a", "1", "1", "famous", "A"), MatchItem("b", "2", "2", "well_known", "B"),
            MatchItem("c", "3", "3", "well_known", "C"), MatchItem("d", "4", "4", "famous", "D")]
    for seed in range(30):
        r = build_round(VARIANTS[0], pool, 1, random.Random(seed), set())
        assert r is not None
        assert not {"sto", "mel"} <= set(r.answers)


def test_order_round_close_but_apart_and_never_presorted() -> None:
    import random

    from geo_pipeline.ordering import VARIANTS, OrderItem, apart, build_round

    v = next(x for x in VARIANTS if x.id == "order_country_area")
    pool = [OrderItem(f"c{i}", f"C{i}", 1000 * 1.2 ** i, 100 - i) for i in range(40)]
    for seed in range(20):
        r = build_round(v, pool, 2, random.Random(seed), set())
        assert r is not None
        values = [i.value for i in r.items]
        assert apart(values, v)
        assert max(values) / min(values) < 1.2 ** 14  # from a window of neighbours
        assert r.answer != list(range(5))
        ranked = [values[p] for p in r.answer]
        assert ranked == sorted(values, reverse=True)
    # too-close values are rejected
    assert not apart([100, 110, 200, 400, 800], v)


def test_haversine() -> None:
    from geo_pipeline.ordering import haversine_km

    # Paris - London ~ 344 km
    assert 330 < haversine_km(48.8566, 2.3522, 51.5074, -0.1278) < 360
