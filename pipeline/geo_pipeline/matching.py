"""Matching rounds (PLAN.md §1, QUESTIONS.md §3.12): pair four left items with four right items.

Variants are defined here rather than in YAML because they pick items per day instead of filtering
a fixed answer set. Each variant has a pool (SQL), how to read the right-hand item, and the pool's
popularity ranking gives every left item a rarity category (which sets its points per pair).

Stored in puzzle_questions with kind='match': valid_entity_ids = the four left ids (in display
order); payload = {"variant", "pairs": [{"left", "right", "right_label", "category"}],
"right_order": [...shuffled right ids/labels]}. The client gets left items and right_order only.
"""

from __future__ import annotations

import bisect
import random
from dataclasses import dataclass, field

from geo_pipeline.questions import rarity_category

# Pairs of flags that are easy to confuse; never put both in an easy round.
SIMILAR_FLAGS = [
    {"TD", "RO", "AD", "MD"}, {"ID", "MC", "PL"}, {"IE", "CI", "IT"}, {"NL", "LU", "FR"},
    {"AU", "NZ"}, {"NO", "IS"}, {"SN", "ML", "GN", "CM"}, {"CO", "EC", "VE"},
    {"SI", "SK", "RU", "RS"}, {"KW", "AE", "JO", "PS", "SD"}, {"QA", "BH"},
    {"EG", "IQ", "SY", "YE"}, {"HN", "NI", "SV"}, {"DK", "CH"}, {"BE", "DE"}, {"HU", "IT", "BG"},
]

EASY_CATEGORIES = {"famous", "well_known"}
HARDER_CATEGORIES = {"familiar", "obscure", "rarest"}


@dataclass(frozen=True)
class MatchVariant:
    id: str
    text: str
    left_type: str
    pool_sql: str  # SELECT left_id, right_id, right_label, popularity, iso2
    distinct_right: bool = True


VARIANTS = [
    MatchVariant(
        id="match_flag_country",
        text="Match each flag to its country",
        left_type="country",
        pool_sql="""SELECT e.id, e.id, e.name, coalesce(e.popularity, 0), e.attrs->>'iso2'
                    FROM entities e WHERE e.type = 'country' AND e.attrs ? 'flag'""",
    ),
    MatchVariant(
        id="match_capital_country",
        text="Match each capital city to its country",
        left_type="city",
        pool_sql="""SELECT e.id, c.id, c.name, coalesce(e.popularity, 0), c.attrs->>'iso2'
                    FROM entities e JOIN entities c ON c.id = e.country_id
                    WHERE e.type = 'city' AND (e.attrs->>'is_capital')::boolean
                    AND e.attrs->>'territory' IS NULL""",
    ),
    MatchVariant(
        id="match_city_continent",
        text="Match each city to its continent",
        left_type="city",
        pool_sql="""SELECT e.id, c.attrs->>'continent', c.attrs->>'continent',
                           coalesce(e.popularity, 0), c.attrs->>'iso2'
                    FROM entities e JOIN entities c ON c.id = e.country_id
                    WHERE e.type = 'city' AND (e.attrs->>'population')::float >= 1000000
                    AND e.attrs->>'territory' IS NULL
                    -- transcontinental countries: our continent is per country, not per city
                    AND c.attrs->>'iso2' NOT IN ('RU', 'TR', 'KZ', 'AZ', 'GE', 'EG')""",
    ),
]


@dataclass
class MatchItem:
    left: str
    right: str
    right_label: str
    category: str
    iso2: str


@dataclass
class MatchRound:
    variant: MatchVariant
    difficulty: int
    items: list[MatchItem]
    right_order: list[str] = field(default_factory=list)

    @property
    def answers(self) -> list[str]:
        return [i.left for i in self.items]

    @property
    def family(self) -> str:
        return "matching"

    @property
    def text(self) -> str:
        return self.variant.text

    def payload(self) -> dict:
        return {
            "variant": self.variant.id,
            "pairs": [{"left": i.left, "right": i.right, "right_label": i.right_label,
                       "category": i.category} for i in self.items],
            "right_order": self.right_order,
        }


def load_pool(cur, variant: MatchVariant) -> list[MatchItem]:
    cur.execute(variant.pool_sql)
    rows = cur.fetchall()
    pops = sorted(r[3] for r in rows)
    out = []
    for left, right, label, pop, iso2 in rows:
        pct = bisect.bisect_left(pops, pop) / len(pops)
        out.append(MatchItem(left, right, label, rarity_category(pct), iso2 or ""))
    return out


def _look_alike(a: MatchItem, b: MatchItem) -> bool:
    return any(a.iso2 in g and b.iso2 in g for g in SIMILAR_FLAGS)


def build_round(variant: MatchVariant, pool: list[MatchItem], difficulty: int,
                rng: random.Random, recently_used: set[str]) -> MatchRound | None:
    """Pick 4 items: easy = all famous/well-known; medium = 2 easy + 2 harder."""
    fresh = [i for i in pool if i.left not in recently_used]
    famous = [i for i in fresh if i.category == "famous"]
    well_known = [i for i in fresh if i.category == "well_known"]
    easy = famous + well_known
    hard = [i for i in fresh if i.category in HARDER_CATEGORIES]
    # easy: 2 famous + 2 well known; medium: 2 famous/well known + 2 familiar or rarer
    want = [(famous, 2), (well_known, 2)] if difficulty == 1 else [(easy, 2), (hard, 2)]
    for _attempt in range(50):
        chosen: list[MatchItem] = []
        for group, n in want:
            candidates = list(group)
            rng.shuffle(candidates)
            taken = 0
            for item in candidates:
                if taken >= n:
                    break
                if variant.distinct_right and any(c.right == item.right for c in chosen):
                    continue
                if any(c.left == item.left for c in chosen):
                    continue
                if (difficulty == 1 and variant.id == "match_flag_country"
                        and any(_look_alike(c, item) for c in chosen)):
                    continue
                chosen.append(item)
                taken += 1
        if len(chosen) == 4:
            rng.shuffle(chosen)
            right_order = [c.right for c in chosen]
            while right_order == [c.right for c in chosen]:
                rng.shuffle(right_order)  # never present the pairs already aligned
            return MatchRound(variant, difficulty, chosen, right_order)
    return None
