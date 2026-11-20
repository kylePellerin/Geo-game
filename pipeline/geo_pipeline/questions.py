"""Question templates: loading, validation, parameter expansion and answer-set evaluation.

See the format notes at the top of templates/flags.yaml. Filters are SQL fragments; parameters are
always bound (never interpolated), referenced as :name.field.
"""

from __future__ import annotations

import bisect
import itertools
import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import yaml

from geo_pipeline.common import PIPELINE_DIR

TEMPLATE_DIR = PIPELINE_DIR / "templates"
ENTITY_TYPES = {"country", "city", "airport"}
KINDS = {"membership", "superlative_per_group", "intersection", "threshold", "relational",
         "name_twist"}
# Rarity categories (QUESTIONS.md §2): each valid answer is placed by its popularity percentile
# within the template's universe. (name, lower percentile bound), most popular first.
RARITY_CATEGORIES = [
    ("famous", 0.85),      # top 15%
    ("well_known", 0.60),  # next 25%
    ("familiar", 0.30),    # next 30%
    ("obscure", 0.02),     # next 28%
    ("rarest", 0.0),       # bottom 2%
]
# Floor: >= FLOOR_MIN answers that are famous or well known. Tail: >= TAIL_MIN that are not famous.
FLOOR_CATEGORIES = {"famous", "well_known"}
FLOOR_MIN, TAIL_MIN = 5, 5


def rarity_category(pct: float) -> str:
    for name, lower in RARITY_CATEGORIES:
        if pct >= lower:
            return name
    return RARITY_CATEGORIES[-1][0]

# Percentiles are measured against the entities a player would plausibly think of, not the whole
# type: every capital is in the top 20% of 31k cities, which would make "obscure capital" impossible.
DEFAULT_UNIVERSE = {
    "country": "TRUE",
    "city": "(e.attrs->>'population')::float >= 100000 OR (e.attrs->>'is_capital')::boolean",
    "airport": "e.attrs->>'airport_type' = 'large'",
}

_PARAM_REF = re.compile(r"(?<![:\w]):([a-z_]\w*)\.([a-z_]\w*)")


@dataclass(frozen=True)
class Template:
    id: str
    family: str
    kind: str
    entity_type: str
    difficulty: int
    text: str
    filter: str
    params: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    min_answers: int = 10
    max_answers: int = 300
    # Pool of entities a player draws answers from, for the floor/tail percentiles (SQL over e, c).
    universe: str | None = None
    # Per-template override of TAIL_MIN, for questions whose answers are all famous by nature
    # (Olympic hosts) where rarity among players still separates common and rare answers.
    tail_min: int | None = None

    @property
    def universe_sql(self) -> str:
        return self.universe or DEFAULT_UNIVERSE[self.entity_type]


@dataclass
class Candidate:
    template: Template
    params: dict[str, dict[str, Any]]
    text: str
    difficulty: int
    answers: list[str] = field(default_factory=list)
    categories: dict[str, str] = field(default_factory=dict)  # entity id -> rarity category

    @property
    def category_counts(self) -> dict[str, int]:
        counts = {name: 0 for name, _ in RARITY_CATEGORIES}
        for cat in self.categories.values():
            counts[cat] += 1
        return counts

    @property
    def n_floor(self) -> int:
        return sum(n for cat, n in self.category_counts.items() if cat in FLOOR_CATEGORIES)

    @property
    def n_tail(self) -> int:
        return len(self.answers) - self.category_counts["famous"]

    @property
    def key(self) -> str:
        """Identity of (template, params) for the no-repeat rule."""
        return self.template.id + json.dumps(self.params, sort_keys=True)

    @property
    def family(self) -> str:
        return self.template.family

    def rejection(self) -> str | None:
        t, n = self.template, len(self.answers)
        if n < t.min_answers:
            return f"too few answers ({n} < {t.min_answers})"
        if n > t.max_answers:
            return f"too many answers ({n} > {t.max_answers})"
        if self.n_floor < FLOOR_MIN:
            return f"easy floor failed ({self.n_floor} famous/well-known answers < {FLOOR_MIN})"
        tail_min = TAIL_MIN if t.tail_min is None else t.tail_min
        if self.n_tail < tail_min:
            return f"tail failed ({self.n_tail} non-famous answers < {tail_min})"
        return None


def load_templates(directory: Path = TEMPLATE_DIR) -> list[Template]:
    templates: list[Template] = []
    for path in sorted(directory.glob("*.yaml")):
        for raw in yaml.safe_load(path.read_text(encoding="utf-8")) or []:
            t = Template(**raw)
            validate(t, path.name)
            templates.append(t)
    ids = [t.id for t in templates]
    if dupes := {i for i in ids if ids.count(i) > 1}:
        raise ValueError(f"duplicate template ids: {sorted(dupes)}")
    return templates


def validate(t: Template, where: str = "") -> None:
    ctx = f"{where}:{t.id}"
    if t.entity_type not in ENTITY_TYPES:
        raise ValueError(f"{ctx}: unknown entity_type {t.entity_type!r}")
    if t.kind not in KINDS:
        raise ValueError(f"{ctx}: unknown kind {t.kind!r}")
    if t.difficulty not in (1, 2, 3):
        raise ValueError(f"{ctx}: difficulty must be 1-3")
    for name, values in t.params.items():
        if not values or not all(isinstance(v, dict) for v in values):
            raise ValueError(f"{ctx}: param {name!r} needs a list of mappings")
    for name, fld in _PARAM_REF.findall(t.filter):
        if name not in t.params:
            raise ValueError(f"{ctx}: filter uses unknown param :{name}.{fld}")
    for name, fld in re.findall(r"\{(\w+)\.(\w+)\}", t.text):
        if name not in t.params or not all(fld in v for v in t.params[name]):
            raise ValueError(f"{ctx}: text uses {{{name}.{fld}}} missing from some values")


def expand(t: Template) -> list[Candidate]:
    """One candidate per combination of parameter values."""
    names = list(t.params)
    out = []
    for combo in itertools.product(*(t.params[n] for n in names)):
        params = {n: {k: v for k, v in val.items() if k != "difficulty"}
                  for n, val in zip(names, combo)}
        overrides = [val["difficulty"] for val in combo if "difficulty" in val]
        text = t.text.format(**{n: SimpleNamespace(**p) for n, p in params.items()})
        out.append(Candidate(t, params, text, max(overrides) if overrides else t.difficulty))
    return out


def compile_filter(t: Template, params: dict[str, dict[str, Any]]) -> tuple[str, dict]:
    """Replace :name.field references with bound parameters (missing fields bind as NULL)."""
    binds: dict[str, Any] = {}

    def sub(m: re.Match) -> str:
        key = f"p_{m.group(1)}_{m.group(2)}"
        binds[key] = params[m.group(1)].get(m.group(2))
        return f"%({key})s"

    sql = _PARAM_REF.sub(sub, t.filter)
    # literal % in the fragment (LIKE patterns come in via params, so this is rare) must be doubled
    sql = re.sub(r"%(?!\(p_)", "%%", sql)
    return sql, binds


# City districts (part_of_city, see ingest/enrich.py) are never valid answers to city questions.
# Cities that are districts of a bigger city, or that only exist in GeoNames (no Wikidata QID:
# mostly districts like Shanghai's Minhang, plus junk like a 2,000,000-person "Amua Ichemidiara"),
# are never valid answers. They stay in the entity table, so the matcher still recognises them.
DISTRICT_FILTER = (
    "AND NOT (e.type = 'city' AND (e.attrs ? 'part_of_city' OR e.id LIKE 'geonames:%%'))"
)

_universe_cache: dict[tuple[str, str], list[float]] = {}


def universe_popularity(cur, t: Template) -> list[float]:
    """Sorted popularity values of the template's universe (cached per type + universe)."""
    key = (t.entity_type, t.universe_sql)
    if key not in _universe_cache:
        cur.execute(
            f"""SELECT coalesce(e.popularity, 0) FROM entities e
                LEFT JOIN entities c ON c.id = e.country_id
                WHERE e.type = %(etype)s AND ({t.universe_sql}) {DISTRICT_FILTER}""",
            {"etype": t.entity_type},
        )
        _universe_cache[key] = sorted(r[0] for r in cur.fetchall())
    return _universe_cache[key]


def evaluate(cur, cand: Candidate) -> Candidate:
    """Fill cand.answers (sorted ids), n_floor and n_tail from the database.

    An answer's percentile = share of the template's universe with lower popularity.
    """
    sql, binds = compile_filter(cand.template, cand.params)
    binds["etype"] = cand.template.entity_type
    cur.execute(
        f"""SELECT e.id, coalesce(e.popularity, 0) FROM entities e
            LEFT JOIN entities c ON c.id = e.country_id
            WHERE e.type = %(etype)s AND ({sql}) {DISTRICT_FILTER} ORDER BY e.id""",
        binds,
    )
    rows = cur.fetchall()
    uni = universe_popularity(cur, cand.template)
    cand.answers = [r[0] for r in rows]
    cand.categories = {
        eid: rarity_category(bisect.bisect_left(uni, pop) / len(uni) if uni else 0.0)
        for eid, pop in rows
    }
    return cand


def overlap(a: list[str] | set[str], b: list[str] | set[str]) -> float:
    """Jaccard similarity |A∩B| / |A∪B|: near 1.0 only when two questions have nearly the same
    answers. (The overlap coefficient flagged any small set inside a big one, e.g. "flag with a
    cross" vs "country in Europe", which made most country questions "overlap".)"""
    a, b = set(a), set(b)
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)
